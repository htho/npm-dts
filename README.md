# npm-dts (fork)

This utility generates single _index.d.ts_ file for whole NPM package.

It allows creating bundled _NPM_ library packages without _TypeScript_ sources and yet still keeping code suggestions wherever these libraries are imported.

_TypeScript_ picks up _index.d.ts_ automatically.

## About This Fork

This fork includes the `--customAlias` and the `--shake` options.
They will hopefully be included in the original some time.

The most recent (but experimental) addition is also copy existing d.ts files,
which may be included in the source. This is useful, when there are d.ts files
that describe the API of a .js file in your code base.

Unfortunately there is no way to include ambient declarations in the bundle.
A d.ts file that has no exports will have no effects.

---

## Installation

Local:

```cmd
npm install --save-dev npm-dts
```

Global:

```cmd
npm install -g npm-dts
```

---

## CLI Usage

Please make sure that target project has _"typescript"_ installed in _node_modules_.

To see full _CLI_ help - run without arguments:

```cmd
npm-dts
```

Typical usage (using global install):

```cmd
cd /your/project
npm-dts generate
```

### Supported options

```cmd
npm-dts [options] generate
```

| Option | Alias | Description |
|--------|-------|-------------|
| `--entry [file]` | `-e [file]` | Allows changing main _src_ file from _index.ts_ to something else. It can also be declared as a path, relative to root. |
| `--force` | `-f` | Ignores non-critical errors and attempts to at least partially generate typings (disabled by default). |
| `--customAlias` | `-a` | Instead of an alias, use the given template, where `{main-module}` is replaced with the name/path of the entry module and `{package-name}` is replaced with the name of the package. |
| `--help` | `-h` | Output usage information. |
| `--logLevel [level]` | `-L [level]` | Log level (`error`, `warn`, `info`, `verbose`, `debug`) (defaults to "info"). |
| `--output [file]` | `-o [file]` | Overrides recommended output target to a custom one (defaults to "index.d.ts"). |
| `--shake` | `-s` | Basic tree-shaking for modules. (`off` (default), `referencedOnly`). `referencedOnly` drops modules not referenced by the entry module. |
| `--root [path]` | `-r [path]` | NPM package directory containing package.json (defaults to current working directory). |
| `--tmp [path]` | `-t [path]` | Directory for storing temporary information (defaults to OS-specific temporary directory). Note that tool completely deletes this folder once finished. |
| `--tsc [options]` | `-c [options]` | Passed through additional TSC options (defaults to ""). Note that they are not validated or checked for suitability. When passing through CLI it is recommended to surround arguments in quotes **and start with a space** (work-around for a bug in argument parsing dependency of _npm-dts_). |
| `--version` | `-v` | Output the version number. |

## Integration using _WebPack_

You would want to use [**"npm-dts-webpack-plugin"**](https://www.npmjs.com/package/npm-dts-webpack-plugin) package instead.

## Integration into _NPM_ scripts

Example of how you could run generation of _index.d.ts_ automatically before every publish.

```json
{
  // ......
  "scripts": {
    "prepublishOnly": "npm run dts && ......",
    "dts": "./node_modules/.bin/npm-dts generate"
  }
  // ......
}
```

Another possible option would be to execute "npm run dts" as part of bundling task.

## Integration into custom solution

This approach can be used for integration with tools such as _WebPack_.

Simple usage with all default values:

```typescript
import {Generator} from 'npm-dts'
new Generator({}).generate()
```

Advanced usage example with some arguments overridden:

```typescript
import * as path from 'path'
import {Generator} from 'npm-dts'

new Generator({
  entry: 'main.ts',
  root: path.resolve(process.cwd(), 'project'),
  tmp: path.resolve(process.cwd(), 'cache/tmp'),
  tsc: '--extendedDiagnostics',
}).generate()
```

Above examples were in _TypeScript_. Same in plain _JavaScript_ would look like this:

```javascript
const path = require('path')

new (require('npm-dts').Generator)({
  entry: 'main.ts',
  root: path.resolve(process.cwd(), 'project'),
  tmp: path.resolve(process.cwd(), 'cache/tmp'),
  tsc: '--extendedDiagnostics',
}).generate()
```

### Additional arguments

Constructor of generator also supports two more boolean flags as optional arguments:

- Enable log
- Throw exception on error

Initializing without any options will cause _npm-cli_ to read CLI arguments all by itself.
