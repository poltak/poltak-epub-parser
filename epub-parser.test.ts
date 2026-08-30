/* @vitest-environment jsdom */
import { ZipReader } from '@zip.js/zip.js'
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { parseEpub } from './src/parser.js'
import {
    createMockEpubFile,
    BOOK_MINIMAL,
    BOOK_COMPLEX,
    BOOK_EDGE_CASE,
    mockChaptersToExpectedData,
    type MockChapter,
    type MockEpubOptions,
} from './test-utils/epub-fixtures.js'

vi.mock('@zip.js/zip.js', () => {
    function BlobReader(this: { file: Blob }, file: Blob) {
        this.file = file
    }

    function ZipReader(
        this: { getEntries: () => Promise<any[]>; close: () => Promise<void> },
        blobReader: { file: Blob },
    ) {
        this.getEntries = vi.fn().mockImplementation(async () => {
            const originalBlob = blobReader.file

            const text = await readBlobText(originalBlob)
            const fileData = JSON.parse(text) as Record<string, string>

            return Object.entries(fileData).map(([filename, content]) => ({
                filename,
                directory: false,
                getData: vi.fn().mockResolvedValue(content),
            }))
        })
        this.close = vi.fn().mockResolvedValue(undefined)
    }

    function TextWriter() {}

    return {
        ZipReader: vi.fn().mockImplementation(function (this: any, blobReader: { file: Blob }) {
            ZipReader.call(this, blobReader)
        }),
        BlobReader: vi.fn().mockImplementation(function (this: any, file: Blob) {
            BlobReader.call(this, file)
        }),
        TextWriter: vi.fn().mockImplementation(function (this: any) {
            TextWriter.call(this)
        }),
    }
})

async function readBlobText(blob: Blob): Promise<string> {
    if (typeof FileReader !== 'undefined') {
        return new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = () => reject(reader.error)
            reader.readAsText(blob)
        })
    }

    if (typeof (blob as Blob).text === 'function') {
        return (blob as Blob).text()
    }

    const buffer = await (blob as Blob).arrayBuffer()
    return new TextDecoder().decode(buffer)
}

function createMockArchive(files: Record<string, string>): Blob {
    return new Blob([JSON.stringify(files)], { type: 'application/epub+zip' })
}

describe('parseEpub', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    describe('parseFile', () => {
        test('should parse a basic EPUB file successfully', async () => {
            const book: MockEpubOptions = {
                title: 'Test Novel',
                author: 'Jane Doe',
                chapters: [
                    { title: 'Prologue', content: 'Once upon a time in a distant land.' },
                    {
                        title: 'The Beginning',
                        content: 'Our hero started their journey with great determination.',
                    },
                ],
            }

            const mockFile = createMockEpubFile(book)
            const result = await parseEpub(mockFile)

            expect(result).toBeDefined()
            expect(result.title).toBe(book.title)
            expect(result.author).toBe(book.author)
            expect(result.chapters).toEqual(mockChaptersToExpectedData(book.chapters!, 'chapters'))
            expect(result.tableOfContents).toEqual(
                mockChaptersToExpectedData(book.chapters!, 'toc'),
            )
            expect(result.allText).toEqual(mockChaptersToExpectedData(book.chapters!, 'all-text'))
        })

        test('should handle chapters with correct order and word counts', async () => {
            const chapters: MockChapter[] = [
                { title: 'Chapter One', content: 'This is a short chapter.' },
                {
                    title: 'Chapter Two',
                    content:
                        'This is a much longer chapter with significantly more words to count properly.',
                },
            ]

            const mockFile = createMockEpubFile({ chapters })
            const result = await parseEpub(mockFile)

            expect(result.chapters[0].order).toBe(0)
            expect(result.chapters[1].order).toBe(1)
            expect(result.chapters[0].wordCount).toBe(7)
            expect(result.chapters[1].wordCount).toBe(15)
        })

        test('should calculate word start indices correctly', async () => {
            const chapters: MockChapter[] = [
                { title: 'First', content: 'One two three four five.' },
                { title: 'Second', content: 'Six seven eight nine ten eleven twelve.' },
            ]

            const mockFile = createMockEpubFile({ chapters })
            const result = await parseEpub(mockFile)

            expect(result.chapters[0].wordStartIndex).toBe(0)
            expect(result.chapters[1].wordStartIndex).toBe(6)
        })

        test('should generate table of contents correctly', async () => {
            const mockFile = createMockEpubFile({
                chapters: [
                    { title: 'Introduction', content: 'Welcome to the book.' },
                    { title: 'Main Content', content: 'Here is the main story.' },
                ],
            })

            const result = await parseEpub(mockFile)

            expect(result.tableOfContents).toHaveLength(2)
            expect(result.tableOfContents[0].title).toBe('Introduction')
            expect(result.tableOfContents[0].href).toMatch(/^#chapter-/)
            expect(result.tableOfContents[0].order).toBe(0)
            expect(result.tableOfContents[0].wordStartIndex).toBe(0)
        })

        test('should combine all text properly', async () => {
            const mockFile = createMockEpubFile({
                chapters: [
                    { title: 'Part 1', content: 'First part content.' },
                    { title: 'Part 2', content: 'Second part content.' },
                ],
            })

            const result = await parseEpub(mockFile)

            expect(result.allText).toContain('First part content')
            expect(result.allText).toContain('Second part content')
            expect(result.allText.split(/\s+/).length).toBe(10)
        })

        test('should handle missing or unknown metadata gracefully', async () => {
            const mockFile = createMockEpubFile({
                title: '',
                author: '',
                chapters: [{ title: 'Only Chapter', content: 'Some content here.' }],
            })

            const result = await parseEpub(mockFile)

            expect(result.title).toBe('Unknown Title')
            expect(result.author).toBe('Unknown Author')
            expect(result.chapters).toHaveLength(1)
        })

        test('should handle chapters without explicit titles', async () => {
            const mockFile = createMockEpubFile({
                chapters: [
                    { title: '', content: 'Content without a clear title.' },
                    { title: '', content: 'Another chapter without title.' },
                ],
            })

            const result = await parseEpub(mockFile)

            expect(result.chapters[0].title).toBe('Chapter 1')
            expect(result.chapters[1].title).toBe('Chapter 2')
        })

        test('should handle empty chapters', async () => {
            const mockFile = createMockEpubFile({
                chapters: [
                    { title: 'Empty Chapter', content: '' },
                    { title: 'Normal Chapter', content: 'This has content.' },
                ],
            })

            const result = await parseEpub(mockFile)

            expect(result.chapters[0].wordCount).toBe(2)
            expect(result.chapters[1].wordCount).toBe(5)
            expect(result.chapters[1].wordStartIndex).toBe(2)
        })

        test('should use predefined minimal book fixture', async () => {
            const mockFile = createMockEpubFile(BOOK_MINIMAL)
            const result = await parseEpub(mockFile)

            expect(result.title).toBe(BOOK_MINIMAL.title)
            expect(result.author).toBe(BOOK_MINIMAL.author)
            expect(result.chapters).toEqual(
                mockChaptersToExpectedData(BOOK_MINIMAL.chapters!, 'chapters'),
            )
            expect(result.tableOfContents).toEqual(
                mockChaptersToExpectedData(BOOK_MINIMAL.chapters!, 'toc'),
            )
            expect(result.allText).toBe(
                mockChaptersToExpectedData(BOOK_MINIMAL.chapters!, 'all-text'),
            )
        })

        test('should use complex book fixture', async () => {
            const mockFile = createMockEpubFile(BOOK_COMPLEX)
            const result = await parseEpub(mockFile)

            expect(result.title).toBe('Complex Test Novel')
            expect(result.author).toBe('Advanced Test Author')
            expect(result.chapters).toEqual(
                mockChaptersToExpectedData(BOOK_COMPLEX.chapters!, 'chapters'),
            )
            expect(result.tableOfContents).toEqual(
                mockChaptersToExpectedData(BOOK_COMPLEX.chapters!, 'toc'),
            )
            expect(result.allText).toEqual(
                mockChaptersToExpectedData(BOOK_COMPLEX.chapters!, 'all-text'),
            )
        })

        test('should handle edge case book fixture', async () => {
            const mockFile = createMockEpubFile(BOOK_EDGE_CASE)
            const result = await parseEpub(mockFile)

            expect(result.title).toBe('Edge Case Book')
            expect(result.chapters).toEqual(
                mockChaptersToExpectedData(BOOK_EDGE_CASE.chapters!, 'chapters'),
            )
            expect(result.tableOfContents).toEqual(
                mockChaptersToExpectedData(BOOK_EDGE_CASE.chapters!, 'toc'),
            )
            expect(result.allText).toEqual(
                mockChaptersToExpectedData(BOOK_EDGE_CASE.chapters!, 'all-text'),
            )
        })
    })

    describe('error handling', () => {
        test('should throw error for invalid file structure', async () => {
            const invalidFile = new Blob(['invalid content'], { type: 'application/epub+zip' })

            await expect(parseEpub(invalidFile)).rejects.toThrow()
        })

        test('should handle missing container.xml', async () => {
            const filesWithoutContainer = { 'some-file.txt': 'content' }
            const invalidFile = new Blob([JSON.stringify(filesWithoutContainer)], {
                type: 'application/epub+zip',
            })

            await expect(parseEpub(invalidFile)).rejects.toThrow('Container.xml not found')
        })

        test('should throw when container.xml lacks rootfile', async () => {
            const files = {
                'META-INF/container.xml': `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles></rootfiles>
</container>`,
            }
            const invalidFile = new Blob([JSON.stringify(files)], { type: 'application/epub+zip' })

            await expect(parseEpub(invalidFile)).rejects.toThrow(
                'Rootfile not found in container.xml',
            )
        })

        test('should throw when OPF file is missing', async () => {
            const files = {
                'META-INF/container.xml': `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/missing.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>`,
            }
            const invalidFile = new Blob([JSON.stringify(files)], { type: 'application/epub+zip' })

            await expect(parseEpub(invalidFile)).rejects.toThrow('OPF file not found')
        })

        test('should close the zip reader even when errors occur', async () => {
            const files = { 'some-file.txt': 'content' }
            const invalidFile = new Blob([JSON.stringify(files)], { type: 'application/epub+zip' })

            await expect(parseEpub(invalidFile)).rejects.toThrow()

            const zipInstance = (ZipReader as unknown as { mock: { instances: any[] } }).mock
                .instances[0]
            expect(zipInstance?.close).toHaveBeenCalled()
        })

        test('should reject malformed container XML with a clear error', async () => {
            const invalidFile = createMockArchive({
                'META-INF/container.xml': '<container><rootfiles>',
            })

            await expect(parseEpub(invalidFile)).rejects.toThrow('Invalid container.xml XML')
        })

        test('should reject malformed OPF XML with a clear error', async () => {
            const invalidFile = createMockArchive({
                'META-INF/container.xml':
                    '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
                'OEBPS/content.opf': '<package><metadata></package>',
            })

            await expect(parseEpub(invalidFile)).rejects.toThrow('Invalid OPF XML')
        })
    })

    describe('EPUB3 nav enhancement', () => {
        test('falls back to NCX when no toc nav is present', async () => {
            const mockFile = createMockEpubFile({
                hasNav: true,
                hasNCX: true,
                navHasToc: false,
                navTitles: ['Landmarks 1', 'Landmarks 2'],
                chapters: [
                    { title: 'NCX Title 1', content: 'Content 1' },
                    { title: 'NCX Title 2', content: 'Content 2' },
                ],
            })

            const result = await parseEpub(mockFile)

            // nav.xhtml uses epub:type="toc"; this test ensures we don't grab a non-toc nav.
            expect(result.chapters[0].title).toBe('NCX Title 1')
            expect(result.chapters[1].title).toBe('NCX Title 2')
        })

        test('uses nav document titles when available', async () => {
            const mockFile = createMockEpubFile({
                hasNav: true,
                hasNCX: false,
                navTitles: ['Nav Title 1', 'Nav Title 2'],
                chapters: [
                    { title: 'NCX Title 1', content: 'Content 1' },
                    { title: 'NCX Title 2', content: 'Content 2' },
                ],
            })

            const result = await parseEpub(mockFile)

            expect(result.chapters[0].title).toBe('Nav Title 1')
            expect(result.chapters[1].title).toBe('Nav Title 2')
        })

        test('prefers nav document over NCX when both exist', async () => {
            const mockFile = createMockEpubFile({
                hasNav: true,
                hasNCX: true,
                navTitles: ['Nav Preferred 1', 'Nav Preferred 2'],
                chapters: [
                    { title: 'NCX Title 1', content: 'Content 1' },
                    { title: 'NCX Title 2', content: 'Content 2' },
                ],
            })

            const result = await parseEpub(mockFile)

            expect(result.chapters[0].title).toBe('Nav Preferred 1')
            expect(result.chapters[1].title).toBe('Nav Preferred 2')
        })

        test('resolves nav links relative to nav document path', async () => {
            const mockFile = createMockEpubFile({
                hasNav: true,
                hasNCX: false,
                navBaseDir: 'nav',
                navLinkPrefix: '../',
                navTitles: ['Nav Subdir 1', 'Nav Subdir 2'],
                chapters: [
                    { title: 'Chapter One', content: 'Content 1' },
                    { title: 'Chapter Two', content: 'Content 2' },
                ],
            })

            const result = await parseEpub(mockFile)

            expect(result.chapters[0].title).toBe('Nav Subdir 1')
            expect(result.chapters[1].title).toBe('Nav Subdir 2')
        })
    })

    describe('normalized navigation paths', () => {
        test('should resolve encoded nav paths and nav targets with query fragments', async () => {
            const mockFile = createMockArchive({
                'META-INF/container.xml':
                    '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
                'OEBPS/content.opf': `
                    <package><metadata><title>Nav Path Test</title><creator>Test Author</creator></metadata>
                    <manifest>
                        <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/>
                        <item id="nav" href="nav%20files/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
                    </manifest>
                    <spine><itemref idref="chapter"/></spine></package>`,
                'OEBPS/Text/chapter.xhtml':
                    '<html><head><title>Document Title</title></head><body><p>Chapter text.</p></body></html>',
                'OEBPS/nav files/nav.xhtml':
                    '<html><body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="../Text/chapter.xhtml?view=reader#start">Navigation Title</a></li></ol></nav></body></html>',
            })

            const result = await parseEpub(mockFile)

            expect(result.chapters[0].title).toBe('Navigation Title')
        })

        test('should normalize NCX paths and targets before matching chapters', async () => {
            const mockFile = createMockArchive({
                'META-INF/container.xml':
                    '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
                'OEBPS/content.opf': `
                    <package><metadata><title>NCX Path Test</title><creator>Test Author</creator></metadata>
                    <manifest>
                        <item id="chapter" href="Text/chapter.xhtml" media-type="application/xhtml+xml"/>
                        <item id="ncx" href="toc%20files/toc.ncx" media-type="application/x-dtbncx+xml"/>
                    </manifest>
                    <spine><itemref idref="chapter"/></spine></package>`,
                'OEBPS/Text/chapter.xhtml':
                    '<html><head><title>Document Title</title></head><body><p>Chapter text.</p></body></html>',
                'OEBPS/toc files/toc.ncx':
                    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap><navPoint><navLabel><text>NCX Title</text></navLabel><content src="../Text/chapter.xhtml?view=reader#start"/></navPoint></navMap></ncx>',
            })

            const result = await parseEpub(mockFile)

            expect(result.chapters[0].title).toBe('NCX Title')
        })
    })

    describe('NCX enhancement', () => {
        test('should enhance chapter titles from NCX when available', async () => {
            const mockFile = createMockEpubFile({
                hasNCX: true,
                chapters: [
                    { title: 'Generic Title 1', content: 'Content 1' },
                    { title: 'Generic Title 2', content: 'Content 2' },
                ],
            })

            const result = await parseEpub(mockFile)

            expect(result.chapters[0].title).toBe('Generic Title 1')
            expect(result.chapters[1].title).toBe('Generic Title 2')
        })

        test('should work without NCX file', async () => {
            const mockFile = createMockEpubFile({
                hasNCX: false,
                chapters: [{ title: 'Original Title', content: 'Content here' }],
            })

            const result = await parseEpub(mockFile)

            expect(result.chapters[0].title).toBe('Original Title')
        })
    })

    describe('text extraction', () => {
        test('should extract clean text from HTML content', async () => {
            const chaptersWithHTML = [
                {
                    title: 'HTML Chapter',
                    content: 'This has emphasized and bold text.',
                },
            ]

            const mockFile = createMockEpubFile({ chapters: chaptersWithHTML })
            const result = await parseEpub(mockFile)

            expect(result.chapters[0].content).toContain('emphasized')
            expect(result.chapters[0].content).toContain('bold')
        })

        test('should handle various heading structures for titles', async () => {
            const chaptersWithHeadings = [
                {
                    title: 'Extracted Title',
                    content: 'Chapter content follows.',
                },
            ]

            const mockFile = createMockEpubFile({ chapters: chaptersWithHeadings })
            const result = await parseEpub(mockFile)

            expect(result.chapters[0].title).toBe('Extracted Title')
        })

        test('should preserve boundaries between adjacent blocks and br elements', async () => {
            const mockFile = createMockArchive({
                'META-INF/container.xml':
                    '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
                'OEBPS/content.opf': `
                    <package>
                        <metadata><title>Boundary Test</title><creator>Test Author</creator></metadata>
                        <manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
                        <spine><itemref idref="chapter"/></spine>
                    </package>`,
                'OEBPS/chapter.xhtml':
                    '<html><head><title>Boundary Test</title></head><body><p>Hello</p><p>world</p><div>third</div><br/>fourth</body></html>',
            })

            const result = await parseEpub(mockFile)

            expect(result.chapters[0].content).toBe('Hello\n\nworld\n\nthird\n\nfourth')
            expect(result.chapters[0].wordCount).toBe(4)
            expect(result.allText).toBe('Hello world third fourth')
        })
    })

    describe('path, metadata, and spine handling', () => {
        test('should resolve encoded OPF-relative paths and normalized metadata', async () => {
            const mockFile = createMockArchive({
                'META-INF/container.xml':
                    '<container><rootfiles><rootfile full-path="./OEBPS/content.opf"/></rootfiles></container>',
                'OEBPS/content.opf': `
                    <opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="3.0">
                        <opf:metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                            <dc:title>  Namespaced Title  </dc:title>
                            <dc:creator>  Namespaced Author  </dc:creator>
                        </opf:metadata>
                        <opf:manifest>
                            <opf:item id="chapter" href="../Text/chapter%201.xhtml?view=reader#start" media-type="APPLICATION/XHTML+XML"/>
                            <opf:item id="supplement" href="supplement.xhtml" media-type="text/html"/>
                        </opf:manifest>
                        <opf:spine>
                            <opf:itemref idref="chapter"/>
                            <opf:itemref idref="supplement" linear="no"/>
                        </opf:spine>
                    </opf:package>`,
                'Text/chapter 1.xhtml':
                    '<html><head><title>Main Chapter</title></head><body><h1>Main Chapter</h1><p>Readable text.</p></body></html>',
                'OEBPS/supplement.xhtml':
                    '<html><body><h1>Supplement</h1><p>Auxiliary text.</p></body></html>',
            })

            const result = await parseEpub(mockFile)

            expect(result.title).toBe('Namespaced Title')
            expect(result.author).toBe('Namespaced Author')
            expect(result.chapters).toHaveLength(1)
            expect(result.chapters[0].content).toContain('Readable text.')
        })

        test('should safely fall back for malformed percent escapes', async () => {
            const mockFile = createMockArchive({
                'META-INF/container.xml':
                    '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
                'OEBPS/content.opf': `
                    <package><metadata><title>Malformed Escape</title><creator>Test Author</creator></metadata>
                    <manifest><item id="chapter" href="chapter%ZZ.xhtml" media-type="text/html"/></manifest>
                    <spine><itemref idref="chapter"/></spine></package>`,
                'OEBPS/chapter%ZZ.xhtml':
                    '<html><head><title>Chapter</title></head><body><p>Still readable.</p></body></html>',
            })

            const result = await parseEpub(mockFile)

            expect(result.chapters).toHaveLength(1)
            expect(result.chapters[0].content).toContain('Still readable.')
        })
    })

    describe('manifest handling', () => {
        test('should skip non-HTML spine items', async () => {
            const files = {
                'META-INF/container.xml': `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>`,
                'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>Test</dc:title>
        <dc:creator>Tester</dc:creator>
    </metadata>
    <manifest>
        <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
        <item id="cover" href="cover.png" media-type="image/png"/>
    </manifest>
    <spine>
        <itemref idref="chapter1"/>
        <itemref idref="cover"/>
    </spine>
</package>`,
                'OEBPS/chapter1.xhtml': `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body><h1>Chapter 1</h1><p>Hello world.</p></body>
</html>`,
                'OEBPS/cover.png': 'not-really-an-image',
            }
            const mockFile = new Blob([JSON.stringify(files)], { type: 'application/epub+zip' })
            const result = await parseEpub(mockFile)

            expect(result.chapters).toHaveLength(1)
            expect(result.chapters[0].title).toBe('Chapter 1')
        })
    })

    test('should close the zip reader on success', async () => {
        const mockFile = createMockEpubFile(BOOK_MINIMAL)
        await parseEpub(mockFile)

        const zipInstance = (ZipReader as unknown as { mock: { instances: any[] } }).mock
            .instances[0]
        expect(zipInstance?.close).toHaveBeenCalled()
    })
})
