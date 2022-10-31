import {readdirSync, statSync, writeFileSync} from 'fs'
import {readFileSync} from 'fs'
import * as mkdir from 'mkdirp'
import * as npmRun from 'npm-run'
import {join, relative, resolve, dirname} from 'path'
import * as rm from 'rimraf'
import * as tmp from 'tmp'
import {
  Cli,
  EAliasPlaceholder,
  ECliArgument,
  EShakeOptions,
  INpmDtsArgs,
} from './cli'
import {debug, ELogLevel, error, info, init, verbose, warn} from './log'
import * as fs from 'fs'
import * as copyfiles from 'copyfiles'

const MKDIR_RETRIES = 5

const REG_STATIC_IMPORT = /(from ['"])([^'"]+)(['"])/
const REG_INLINE_IMPORT = /(import\(['"])([^'"]+)(['"]\))/

/**
 * Logic for generating aggregated typings for NPM module
 */
export class Generator extends Cli {
  private packageInfo: any
  private modules = new Map<string, string>()
  private shakenModules = new Map<string, string>()
  private shakeStrategy: (lines: string[]) => string[]
  private source = ''
  private throwErrors: boolean
  private cacheContentEmptied: boolean = true

  /**
   * Auto-launches generation based on command line arguments
   * @param injectedArguments generation arguments (same as CLI)
   * @param enableLog enables logging when true, null allows application to decide
   * @param throwErrors makes generation throw errors when true
   */
  public constructor(
    injectedArguments?: INpmDtsArgs,
    enableLog: boolean | null = null,
    throwErrors = false,
  ) {
    super(injectedArguments)

    this.throwErrors = throwErrors

    if (enableLog === null) {
      enableLog = !injectedArguments
    }

    if (enableLog) {
      init('npm-dts', this.getLogLevel())

      const myPackageJson = JSON.parse(
        readFileSync(resolve(__dirname, '..', 'package.json'), {
          encoding: 'utf8',
        }),
      )

      const soft = `          npm-dts v${myPackageJson.version}                `
      let author = '          by Vytenis Urbonavičius                          '
      let spaces = '                                                           '
      let border = '___________________________________________________________'

      author = author.substring(0, soft.length)
      spaces = spaces.substring(0, soft.length)
      border = border.substring(0, soft.length)

      info(` ${border} `)
      info(`|${spaces}|`)
      info(`|${spaces}|`)
      info(`|${soft}|`)
      info(`|${author}|`)
      info(`|${spaces}|`)
      info(`|${border}|`)
      info(` ${spaces} `)
    }
  }

  /**
   * Executes generation of an aggregated dts file
   */
  public async generate() {
    info(`Generating declarations for "${this.getRoot()}"...`)

    let hasError = false
    let exception = null
    const cleanupTasks: (() => void)[] = []

    if (!this.tmpPassed) {
      verbose('Locating OS Temporary Directory...')

      try {
        await new Promise<void>(done => {
          tmp.dir((tmpErr, tmpDir, rmTmp) => {
            if (tmpErr) {
              error('Could not create OS Temporary Directory!')
              this.showDebugError(tmpErr)
              throw tmpErr
            }

            verbose('OS Temporary Directory was located!')
            this.setArgument(ECliArgument.tmp, resolve(tmpDir, 'npm-dts'))

            cleanupTasks.push(() => {
              verbose('Deleting OS Temporary Directory...')
              rmTmp()
              verbose('OS Temporary Directory was deleted!')
            })
            done()
          })
        })
      } catch (e) {
        hasError = true
        exception = e
      }
    }

    if (!hasError) {
      await this._generate().catch(async e => {
        hasError = true

        const output = this.getOutput()

        error(`Generation of ${output} has failed!`)
        this.showDebugError(e)

        if (!this.useForce()) {
          if (this.getLogLevel() === ELogLevel.debug) {
            info(
              'If issue is not severe, you can try forcing execution using force flag.',
            )
            info(
              'In case of command line usage, add "-f" as the first parameter.',
            )
          } else {
            info('You should try running npm-dts with debug level logging.')
            info(
              'In case of command line, debug mode is enabled using "-L debug".',
            )
          }
        }

        if (!this.cacheContentEmptied) {
          await this.clearTypings()
        }

        exception = e
      })
    }

    cleanupTasks.forEach(task => task())

    if (!hasError) {
      info('Generation is completed!')
    } else {
      error('Generation failed!')

      if (this.throwErrors) {
        throw exception || new Error('Generation failed!')
      }
    }
  }

  /**
   * Logs serialized error if it exists
   * @param e - error to be shown
   */
  private showDebugError(e: any) {
    if (e) {
      if (e.stdout) {
        debug(`Error: \n${e.stdout.toString()}`)
      } else {
        debug(`Error: \n${JSON.stringify(e)}`)
      }
    }
  }

  /**
   * Launches generation of typings
   */
  private async _generate() {
    await this.gatherTypings()
    this.mapTypingsToModules()
    await this.clearTypings()

    this.transformModules()

    this.joinModules()
    this.appendAlias()

    await this.writeOutputFile()
  }

  private getLogLevel(): ELogLevel {
    const logLevel = this.getArgument(ECliArgument.logLevel) as ELogLevel
    return ELogLevel[logLevel] ? logLevel : ELogLevel.info
  }

  /**
   * Gathers entry file address (relative to project root path)
   */
  private getEntry(): string {
    return this.getArgument(ECliArgument.entry) as string
  }

  /**
   * Gathers target project root path
   */
  private getRoot(): string {
    return resolve(this.getArgument(ECliArgument.root) as string)
  }

  /**
   * Gathers TMP directory to be used for TSC operations
   */
  private getTempDir(): string {
    return resolve(this.getArgument(ECliArgument.tmp) as string)
  }

  /**
   * Gathers output path to be used (relative to root)
   */
  private getOutput(): string {
    return this.getArgument(ECliArgument.output) as string
  }

  /**
   * Gathers the template for the alias.
   * Either the default or userProvided
   */
  private getAliasTemplate(): string | undefined {
    return this.getArgument(ECliArgument.customAlias) as string
  }

  /**
   * Checks if script is forced to use its built-in TSC
   */
  private useTestMode(): boolean {
    return this.getArgument(ECliArgument.testMode) as boolean
  }

  /**
   * Checks if script is forced to attempt generation despite errors
   */
  private useForce(): boolean {
    return this.getArgument(ECliArgument.force) as boolean
  }

  /**
   * Gathers the tree-shaking strategy
   */
  private getShake(): EShakeOptions {
    const shake = this.getArgument(ECliArgument.shake) as EShakeOptions
    if (EShakeOptions[shake]) return shake
    warn(
      `Unknown --shake strategy "${shake}". Fallback to "${EShakeOptions.off}"`,
    )
    warn(
      `Available --shake strategies are: ${JSON.stringify(
        Object.keys(EShakeOptions),
      )}`,
    )
    return EShakeOptions.off
  }

  private needToShake(): boolean {
    return this.getShake() !== EShakeOptions.off
  }

  /**
   * Creates TMP directory to be used for TSC operations
   * @param retries amount of times to retry on failure
   */
  private makeTempDir(retries = MKDIR_RETRIES): Promise<void> {
    const tmpDir = this.getTempDir()
    verbose('Preparing "tmp" directory...')

    return new Promise((done, fail) => {
      mkdir(tmpDir)
        .then(() => {
          this.cacheContentEmptied = false
          verbose('"tmp" directory was prepared!')
          done()
        })
        .catch(mkdirError => {
          error(`Failed to create "${tmpDir}"!`)
          this.showDebugError(mkdirError)

          if (retries) {
            const sleepTime = 100
            verbose(`Will retry in ${sleepTime}ms...`)

            setTimeout(() => {
              this.makeTempDir(retries - 1).then(done, fail)
            }, sleepTime)
          } else {
            error(`Stopped trying after ${MKDIR_RETRIES} retries!`)
            fail()
          }
        })
    })
  }

  /**
   * Clears per-file typings - Removes TMP directory
   */
  private clearTypings() {
    const tmpDir = this.getTempDir()
    verbose('Cleaning up "tmp" directory...')

    return new Promise<void>((done, fail) => {
      rm(tmpDir, rmError => {
        if (rmError) {
          error(`Could not clean up "tmp" directory at "${tmpDir}"!`)
          this.showDebugError(rmError)
          fail()
        } else {
          this.cacheContentEmptied = true
          verbose('"tmp" directory was cleaned!')
          done()
        }
      })
    })
  }

  /**
   * Re-creates empty TMP directory to be used for TSC operations
   */
  private resetCacheDir() {
    verbose('Will now reset "tmp" directory...')
    return new Promise((done, fail) => {
      this.clearTypings().then(() => {
        this.makeTempDir().then(done, fail)
      }, fail)
    })
  }

  private async gatherTypings() {
    await this.resetCacheDir()
    await this.copyTypings()
    await this.generateTypings()
  }

  /**
   * Generates per-file typings using TSC
   */
  private async generateTypings() {
    verbose('Generating per-file typings using TSC...')

    const tscOptions = this.getArgument(ECliArgument.tsc) as string

    const cmd =
      'tsc --declaration --emitDeclarationOnly --declarationDir "' +
      this.getTempDir() +
      '"' +
      (tscOptions.length ? ` ${tscOptions}` : '')

    debug(cmd)

    try {
      npmRun.execSync(
        cmd,
        {
          cwd: this.useTestMode() ? resolve(__dirname, '..') : this.getRoot(),
        },
        (err: any, stdout: any, stderr: any) => {
          if (err) {
            if (this.useForce()) {
              warn('TSC exited with errors!')
            } else {
              error('TSC exited with errors!')
            }

            this.showDebugError(err)
          } else {
            if (stdout) {
              process.stdout.write(stdout)
            }

            if (stderr) {
              process.stderr.write(stderr)
            }
          }
        },
      )
    } catch (e) {
      if (this.useForce()) {
        warn('Suppressing errors due to "force" flag!')
        this.showDebugError(e)
        warn('Generated declaration files might not be valid!')
      } else {
        throw e
      }
    }

    verbose('Per-file typings have been generated using TSC!')
  }

  /**
   * Copies existing .d.ts files from project
   */
  private async copyTypings() {
    const root = './'
    const src = `${root}/**/*.d.ts`
    const dst = relative(root, this.getTempDir())
    verbose(`Copying existing .d.ts files from... ${src} to ${dst}`)
    await new Promise<void>((done, fail) =>
      copyfiles([src, dst], {up: 0}, err => (err ? fail(err) : done())),
    )
    verbose('Existing .d.ts files have been copied!')
  }

  /**
   * Gathers a list of created per-file declaration files
   * @param dir directory to be scanned for files (called during recursion)
   * @param files discovered array of files (called during recursion)
   */
  private getDeclarationFiles(
    dir: string = this.getTempDir(),
    files: string[] = [],
  ) {
    if (dir === this.getTempDir()) {
      verbose('Loading list of generated typing files...')
    }

    try {
      readdirSync(dir).forEach(file => {
        if (statSync(join(dir, file)).isDirectory()) {
          files = this.getDeclarationFiles(join(dir, file), files)
        } else {
          files = files.concat(join(dir, file))
        }
      })
    } catch (e) {
      error('Failed to load list of generated typing files...')
      this.showDebugError(e)
      throw e
    }

    if (dir === this.getTempDir()) {
      verbose('Successfully loaded list of generated typing files!')
    }

    return files
  }

  /**
   * Loads package.json information of target project
   */
  private getPackageDetails() {
    if (this.packageInfo) {
      return this.packageInfo
    }

    verbose('Loading package.json...')

    const root = this.getRoot()
    const packageJsonPath = resolve(root, 'package.json')

    try {
      this.packageInfo = JSON.parse(
        readFileSync(packageJsonPath, {encoding: 'utf8'}),
      )
    } catch (e) {
      error(`Failed to read package.json at "'${packageJsonPath}'"`)
      this.showDebugError(e)
      throw e
    }

    verbose('package.json information has been loaded!')
    return this.packageInfo
  }

  /**
   * Generates module name based on file path
   * @param path path to be converted to module name
   * @param options additional conversion options
   */
  private convertPathToModule(
    path: string,
    options: IConvertPathToModuleOptions = {},
  ) {
    const {
      rootType = IBasePathType.tmp,
      noPrefix = false,
      noExtensionRemoval = false,
      noExistenceCheck = false,
    } = options

    const packageDetails = this.getPackageDetails()

    const fileExisted =
      noExistenceCheck ||
      (!noExtensionRemoval &&
        fs.existsSync(path) &&
        fs.lstatSync(path).isFile())

    if (rootType === IBasePathType.cwd) {
      path = relative(process.cwd(), path)
    } else if (rootType === IBasePathType.root) {
      path = relative(this.getRoot(), path)
    } else if (rootType === IBasePathType.tmp) {
      path = relative(this.getTempDir(), path)
    }

    if (!noPrefix) {
      path = `${packageDetails.name}/${path}`
    }

    path = path.replace(/\\/g, '/')

    if (fileExisted && !noExtensionRemoval) {
      path = path.replace(/\.[^.]+$/g, '')
      path = path.replace(/\.d$/g, '')
    }

    return path
  }

  /**
   * Loads generated per-file declaration files
   */
  private mapTypingsToModules() {
    const declarationFiles = this.getDeclarationFiles()

    verbose('Loading declaration files and mapping to modules...')
    declarationFiles.forEach(file => {
      const moduleName = this.convertPathToModule(file)

      try {
        const fileSource = readFileSync(file, {encoding: 'utf8'})
        this.modules.set(moduleName, fileSource)
      } catch (e) {
        error(`Could not load declaration file '${file}'!`)
        this.showDebugError(e)
        throw e
      }
    })

    verbose('Loaded declaration files and mapped to modules!')
  }

  private resolveImportSourcesAtLine(
    regexp: RegExp,
    line: string,
    moduleName: string,
  ) {
    const matches = line.match(regexp)

    if (matches && matches[2].startsWith('.')) {
      const relativePath = `../${matches[2]}`

      let resolvedModule = resolve(moduleName, relativePath)

      resolvedModule = this.convertPathToModule(resolvedModule, {
        rootType: IBasePathType.cwd,
        noPrefix: true,
        noExtensionRemoval: true,
      })

      if (!this.moduleExists(resolvedModule)) {
        resolvedModule += '/index'
      }

      line = line.replace(regexp, `$1${resolvedModule}$3`)
    }

    return line
  }

  private removeDeclareKeyword() {
    this.modules.forEach((fileSource, moduleName) => {
      fileSource = fileSource.replace(/declare /g, '')
      this.modules.set(moduleName, fileSource)
    })
  }
  private resolveImportSources() {
    this.modules.forEach((fileSource, moduleName) => {
      fileSource = this.resolveImportSourcesAtFile(fileSource, moduleName)
      this.modules.set(moduleName, fileSource)
    })
  }

  private resolveImportSourcesAtFile(source: string, moduleName: string) {
    let lines = this.splitSourceToLines(source)

    lines = lines.map(line => {
      line = this.resolveImportSourcesAtLine(
        REG_STATIC_IMPORT,
        line,
        moduleName,
      )

      line = this.resolveImportSourcesAtLine(
        REG_INLINE_IMPORT,
        line,
        moduleName,
      )

      return line
    })

    source = lines.join('\n')

    return source
  }

  private splitSourceToLines(source: string) {
    source = source.replace(/\r\n/g, '\n')
    source = source.replace(/\n\r/g, '\n')
    source = source.replace(/\r/g, '\n')

    const lines = source.split('\n')
    return lines
  }

  private shake(): void {
    const shake = this.getShake()

    verbose(`Shaking typings using the ${shake} strategy.`)

    this.shakeStrategy = shakeStrategies[shake]
    this.recursivelyAddShakenModuleNames(this.getMainModule())

    this.modules = new Map(this.shakenModules)
  }

  private recursivelyAddShakenModuleNames(moduleName: string): void {
    const fileSource = this.modules.get(moduleName)
    if (fileSource === undefined) {
      warn(`no typings for "${moduleName}"`)
      return
    }
    this.shakenModules.set(moduleName, fileSource)

    const lines = this.splitSourceToLines(fileSource)
    const referencedModules = this.shakeStrategy(lines)

    verbose(`"${moduleName}" references ${JSON.stringify(referencedModules)}`)

    for (const referencedModule of referencedModules) {
      if (this.shakenModules.has(referencedModule)) continue
      this.recursivelyAddShakenModuleNames(referencedModule)
    }
  }

  private transformModules() {
    verbose('Applying transformations to typings...')
    this.removeDeclareKeyword()
    this.resolveImportSources()

    if (this.needToShake()) this.shake()

    this.indentSources()
    this.wrapModuleInDeclaration()
    verbose('Applyied transformations to typings!')
  }

  private joinModules() {
    verbose('Combining typings into single file...')
    this.source = Array.from(this.modules.values()).join('\n')
    verbose('Combined typings into a single file!')
  }

  private indentSources() {
    this.modules.forEach((fileSource, moduleName) => {
      this.modules.set(moduleName, fileSource.replace(/^./gm, '  $&'))
    })
  }
  private wrapModuleInDeclaration() {
    this.modules.forEach((fileSource, moduleName) => {
      this.modules.set(
        moduleName,
        `declare module '${moduleName}' {\n${fileSource}\n}`,
      )
    })
  }

  /**
   * Verifies if module specified exists among known modules
   * @param moduleName name of module to be checked
   */
  private moduleExists(moduleName: string) {
    return this.modules.has(moduleName)
  }

  /**
   * Adds an alias for the main NPM package file to the
   * generated .d.ts source
   */
  private appendAlias() {
    verbose('Adding alias for main file of the package...')

    const packageDetails = this.getPackageDetails()
    const mainModule = this.getMainModule()
    const appliedTemplate = this.getAliasTemplate()
      .replace('{' + EAliasPlaceholder.MainModule + '}', mainModule)
      .replace('{' + EAliasPlaceholder.PackageName + '}', packageDetails.name)

    this.source += '\n' + appliedTemplate + '\n'

    verbose('Successfully created alias for main file!')
  }

  private getMainModule() {
    const entry = this.getEntry()

    if (!entry) {
      error('No entry file is available!')
      throw new Error('No entry file is available!')
    }

    const mainModule = this.convertPathToModule(
      resolve(this.getRoot(), entry),
      {
        rootType: IBasePathType.root,
        noExistenceCheck: true,
      },
    )
    return mainModule
  }

  /**
   * Stores generated .d.ts declaration source into file
   */
  private async writeOutputFile() {
    const output = this.getOutput()
    const root = this.getRoot()
    const file = resolve(root, output)
    const folderPath = dirname(file)

    verbose('Ensuring that output folder exists...')
    debug(`Creating output folder: "${folderPath}"...`)

    try {
      await mkdir(folderPath)
    } catch (mkdirError) {
      error(`Failed to create "${folderPath}"!`)
      this.showDebugError(mkdirError)
      throw mkdirError
    }

    verbose('Output folder is ready!')
    verbose(`Storing typings into ${output} file...`)

    try {
      writeFileSync(file, this.source, {encoding: 'utf8'})
    } catch (e) {
      error(`Failed to create ${output}!`)
      this.showDebugError(e)
      throw e
    }

    verbose(`Successfully created ${output} file!`)
  }
}

const shakeStrategies = {
  [EShakeOptions.off]: (lines: string[]) => lines,

  [EShakeOptions.referencedOnly]: (lines: string[]) => {
    const refs = [
      ...lines.map(line => line.match(REG_STATIC_IMPORT)),
      ...lines.map(line => line.match(REG_INLINE_IMPORT)),
    ]
    return refs.filter(match => match !== null).map(match => match[2])
  },
}

/**
 * Types of base path used during path resolving
 */
export enum IBasePathType {
  /**
   * Base path is root of targeted project
   */
  root = 'root',

  /**
   * Base path is tmp directory
   */
  tmp = 'tmp',

  /**
   * Base path is CWD
   */
  cwd = 'cwd',
}

/**
 * Additional conversion options
 */
export interface IConvertPathToModuleOptions {
  /**
   * Type of base path used during path resolving
   */
  rootType?: IBasePathType

  /**
   * Disables addition of module name as prefix for module name
   */
  noPrefix?: boolean

  /**
   * Disables extension removal
   */
  noExtensionRemoval?: boolean

  /**
   * Disables existence check and assumes that file exists
   */
  noExistenceCheck?: boolean
}
