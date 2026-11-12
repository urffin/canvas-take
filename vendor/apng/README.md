# Pinned APNG integration sources

These files are pristine, checked by SHA-256 before every build and preserved byte-for-byte by
`.gitattributes`. No build-time download or runtime npm dependency is required.

| File | Source | SHA-256 |
| --- | --- | --- |
| UPNG.js | [UPNG 88f504b](https://raw.githubusercontent.com/photopea/UPNG.js/88f504b6577b726975f593caa38ba85d327c7c1f/UPNG.js) | `39213412bc9945002588f5e12adfc555c63d314874bba1dbed5be802b1c86ed2` |
| UPNG-LICENSE | [UPNG MIT](https://raw.githubusercontent.com/photopea/UPNG.js/88f504b6577b726975f593caa38ba85d327c7c1f/LICENSE) | `c1fb8861eca211bf5aea574358aba7039396c0c1824c2a1477cc126d398efd89` |
| pako-deflate.cjs | [Pako 2.1.0 deflate](https://raw.githubusercontent.com/nodeca/pako/2.1.0/dist/pako_deflate.min.js) | `9429785d1e7f805d46640c4155957fd0f286144dec05cea09f6f2eaa646adb21` |
| pako-LICENSE | [Pako MIT](https://raw.githubusercontent.com/nodeca/pako/2.1.0/LICENSE) | `a04665b3b2de56c66730c1f720f528175739e4104f79073614aa611da1e85539` |
| pako-zlib-README | [Zlib notices](https://raw.githubusercontent.com/nodeca/pako/2.1.0/lib/zlib/README) | `d8b499598e43d755ea8918448128259ff01820c50d94d5a48c8883d0a594ddb1` |

`scripts/apng-upng-patch.mjs` applies the three guarded changes verified by the backend spike:
single-frame animation metadata, real deflate in encodeLL and explicit Pako selection. Its result
is checked against the spike transform. The writer remains UPNG; CanvasTake adds no PNG compressor.
Only full RGBA8 SOURCE/BACKGROUND frames are used. Palette/rectangle optimization is excluded.

`scripts/apng-build.mjs` bundles this code only into private APNG codec assets with full source maps.
It copies pristine sources, all notices and the transform into `dist/internal/apng-sources/`, and
writes `apng-PROVENANCE.md`. Root/GIF/video controllers do not import these sources. The integration
has no public APNG entry yet and is not part of the already published 0.6.1 artifact.
