# smol-toml provenance

Vendored copy of the published `smol-toml` npm package's ESM build
(`dist/index.js` and the modules it imports, with their `.d.ts`
declarations). `dist/index.cjs` (the CommonJS build) is not vendored.
No runtime dependencies.

- Package: `smol-toml`
- Version: 1.9.1
- Author: Cynthia Rey <cynthia@cynthia.dev>
- Licence: BSD-3-Clause (see `LICENSE` in this directory; the same notice is
  also embedded at the top of each vendored source file)
- Upstream repository: https://github.com/squirrelchat/smol-toml
- Source commit: `69aa050fef018b71799519bb2cbb54f158a0c5f9`
  (the commit tag `v1.9.1`, `19fb510266f994f6c2d28c9c6610cbf289e74227`,
  resolves to)
- npm tarball: https://registry.npmjs.org/smol-toml/-/smol-toml-1.9.1.tgz
- Tarball integrity:
  - sha256 `4ac8392f1918c22a4366be19047cf53aa42646077d4c711b2ef73263beefb172`
  - sha512 (npm `dist.integrity`)
    `j7WyPdf0CJoutMzMoPLF/bVXHtKZIT9Rb4eGeEbWw8X2t5oirjPgpL+OpaENZrILYaXqYwnVH+qgUwVbl+pUJQ==`

The vendored files are byte-identical to the published tarball's `dist/`
entries. The parser is exercised against Python 3.12 `tomllib` on every TOML
fixture in the repository (including documents both parsers must reject); see
`tests/` for the parity check.
