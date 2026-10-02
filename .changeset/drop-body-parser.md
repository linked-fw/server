---
'@_linked/server': patch
---

Drop the unused direct `body-parser` dependency. The server has always parsed request bodies with Express 4's built-in `express.json({ limit: '50mb' })` (body-parser 1.x bundled inside Express), so nothing changes at runtime. The parser now lives in `createJsonBodyParser()` and its behaviour — `/call` arguments, the 50mb limit, 413/400 errors, multipart and urlencoded bodies left unparsed — is covered by tests.
