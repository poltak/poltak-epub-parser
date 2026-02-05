# poltak-epub-parser

A lightweight EPUB parsing library based on zip.js. It extracts metadata, chapters, a table of contents, and a combined text stream from an EPUB file.

It is intended for browser use only (not Node).

## Install

```bash
npm install poltak-epub-parser
```

## Usage

```ts
import { parseEpub } from 'poltak-epub-parser'

const input = document.querySelector('input[type="file"]')

input.addEventListener('change', async () => {
    const file = input.files?.[0]
    if (!file) return

    const data = await parseEpub(file)
    console.log(data.title)
    console.log(data.author)
    console.log(data.tableOfContents)
})
```

## API

### `parseEpub(file: File | Blob): Promise<EpubData>`

Parses an EPUB file and returns:

- `title`: string
- `author`: string
- `chapters`: array of `{ id, title, content, order, wordStartIndex, wordCount }`
- `tableOfContents`: array of `{ title, href, order, wordStartIndex }`
- `allText`: combined text for speed-reading and indexing

## Notes

- This library depends on browser APIs (`DOMParser`, `File`, `Blob`) and does not support Node.
- EPUB3 `nav` support is not implemented yet (NCX is supported).
- For publishing, run `npm run build` to generate `dist/`. You can then point the package exports to `dist` if you want to ship compiled output.

