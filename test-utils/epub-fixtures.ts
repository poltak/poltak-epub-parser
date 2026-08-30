import type { Chapter, TableOfContents } from '../src/parser.js'

export interface MockChapter {
    title: string
    content: string
}

export interface MockEpubOptions {
    title?: string
    author?: string
    chapters?: MockChapter[]
    /** Denotes whether the EPUB has a Table of Contents (NCX) file. */
    hasNCX?: boolean
    /** Denotes whether the EPUB has an EPUB3 navigation document. */
    hasNav?: boolean
    /** Optional override titles for nav entries. */
    navTitles?: string[]
    /** Optional base directory for nav document, relative to OPF. */
    navBaseDir?: string
    /** Optional prefix for nav links (e.g. '../'). */
    navLinkPrefix?: string
    /** Whether to include a toc nav section. */
    navHasToc?: boolean
    language?: string
}

/**
 * Sample minimal book for basic testing
 */
export const BOOK_MINIMAL: MockEpubOptions = {
    title: 'Test Book',
    author: 'Test Author',
    chapters: [
        { title: 'Chapter 1', content: 'This is the first chapter.' },
        { title: 'Chapter 2', content: 'This is the second chapter.' },
    ],
}

/**
 * Complex book with various edge cases
 */
export const BOOK_COMPLEX: MockEpubOptions = {
    title: 'Complex Test Novel',
    author: 'Advanced Test Author',
    chapters: [
        {
            title: 'The Journey Begins',
            content:
                `It was a bright cold day in April, and the clocks were striking thirteen. ` +
                `This is the beginning of our story, where everything starts to unfold in ways ` +
                `no one could have predicted. The protagonist faces their first major challenge.`,
        },
        {
            title: 'Rising Action',
            content:
                `The conflict intensifies as our hero encounters obstacles that test their ` +
                `resolve. Each challenge brings new revelations about the world they inhabit. ` +
                `Allies are made and enemies revealed in this pivotal chapter of the narrative.`,
        },
        {
            title: 'The Climax',
            content:
                `Everything comes to a head in this crucial moment. The fate of all characters ` +
                `hangs in the balance as the final confrontation approaches. Decisions made here ` +
                `will determine the outcome of the entire story arc.`,
        },
        {
            title: 'Resolution',
            content:
                `After the storm comes the calm. Our characters reflect on their journey and ` +
                `the lessons learned. The world has changed, and so have they. This conclusion ` +
                `ties together all the loose threads of the narrative.`,
        },
    ],
    hasNCX: true,
}

/**
 * Book with problematic content for edge case testing
 */
export const BOOK_EDGE_CASE: MockEpubOptions = {
    title: 'Edge Case Book',
    author: 'Edge Case Author',
    chapters: [
        { title: '', content: 'Chapter with no title.' },
        {
            title: 'Chapter with HTML tags',
            content: '<p>Content with <em>markup</em> and <script>alert("test")</script></p>',
        },
        { title: 'Empty Chapter', content: '' },
        {
            title: 'Very Long Title That Goes On And On And On And On And On And On And On And On And On And On And On And On And On And On And Should Be Handled Gracefully',
            content: 'Short content.',
        },
    ],
    hasNCX: false,
}

/**
 * Expected word counts for validation
 */
export const expectedWordCounts = {
    sampleChapters: [41, 35, 38, 36], // Approximate word counts for each sample chapter
    minimalBook: [5, 5], // "This is the first chapter." = 5 words
    complexBook: [41, 35, 38, 36],
}

/**
 * Creates a mock EPUB file for testing
 */
export const createMockEpubFile = (options: MockEpubOptions): Blob => {
    const {
        title = 'Test Book',
        author = 'Test Author',
        chapters = [
            { title: 'Chapter 1', content: 'This is the first chapter content.' },
            { title: 'Chapter 2', content: 'This is the second chapter with more text content.' },
        ],
        hasNCX = true,
        hasNav = false,
        navTitles = [],
        navBaseDir = '',
        navLinkPrefix = '',
        navHasToc = true,
    } = options

    const files = new Map<string, string>()

    files.set(
        'META-INF/container.xml',
        `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
    </rootfiles>
</container>`,
    )

    const manifestItems = chapters
        .map(
            (_, i) =>
                `<item id="chapter${i + 1}" href="chapter${i + 1}.xhtml" media-type="application/xhtml+xml"/>`,
        )
        .join('\n        ')

    const spineItems = chapters
        .map((_, i) => `<itemref idref="chapter${i + 1}"/>`)
        .join('\n        ')

    const ncxItem = hasNCX
        ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
        : ''
    const normalizedNavBaseDir =
        navBaseDir && !navBaseDir.endsWith('/') ? `${navBaseDir}/` : navBaseDir
    const navItem = hasNav
        ? `<item id="nav" href="${normalizedNavBaseDir}nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`
        : ''
    const ncxSpine = hasNCX ? ' toc="ncx"' : ''

    files.set(
        'OEBPS/content.opf',
        `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
        <dc:title>${title}</dc:title>
        <dc:creator>${author}</dc:creator>
        <dc:identifier id="BookId">test-book-123</dc:identifier>
    </metadata>
    <manifest>
        ${manifestItems}
        ${ncxItem}
        ${navItem}
    </manifest>
    <spine${ncxSpine}>
        ${spineItems}
    </spine>
</package>`,
    )

    chapters.forEach((chapter, i) => {
        files.set(
            `OEBPS/chapter${i + 1}.xhtml`,
            `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <title>${chapter.title}</title>
</head>
<body>
    <h1>${chapter.title}</h1>
    <p>${chapter.content}</p>
</body>
</html>`,
        )
    })

    if (hasNCX) {
        const navPoints = chapters
            .map(
                (chapter, i) => `
        <navPoint id="navpoint-${i + 1}" playOrder="${i + 1}">
            <navLabel>
                <text>${chapter.title}</text>
            </navLabel>
            <content src="chapter${i + 1}.xhtml"/>
        </navPoint>`,
            )
            .join('')

        files.set(
            'OEBPS/toc.ncx',
            `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
    <head>
        <meta name="dtb:uid" content="test-book-123"/>
    </head>
    <docTitle>
        <text>${title}</text>
    </docTitle>
    <navMap>
        ${navPoints}
    </navMap>
</ncx>`,
        )
    }

    if (hasNav) {
        const navItems = chapters
            .map((chapter, i) => {
                const navTitle = navTitles[i] ?? chapter.title
                return `<li><a href="${navLinkPrefix}chapter${i + 1}.xhtml">${navTitle}</a></li>`
            })
            .join('\n        ')

        files.set(
            `OEBPS/${normalizedNavBaseDir}nav.xhtml`,
            `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
    <title>Navigation</title>
</head>
<body>
    <nav epub:type="landmarks">
        <ol>
            <li><a href="cover.xhtml">Cover</a></li>
        </ol>
    </nav>
    ${
        navHasToc
            ? `<nav epub:type="toc">
        <ol>
        ${navItems}
        </ol>
    </nav>`
            : ''
    }
</body>
</html>`,
        )
    }

    return new Blob([JSON.stringify(Object.fromEntries(files))], { type: 'application/epub+zip' })
}

export function mockChaptersToExpectedData(chapters: MockChapter[], type: 'chapters'): Chapter[]
export function mockChaptersToExpectedData(chapters: MockChapter[], type: 'toc'): TableOfContents[]
export function mockChaptersToExpectedData(chapters: MockChapter[], type: 'all-text'): string
export function mockChaptersToExpectedData(
    chapters: MockChapter[],
    type: 'chapters' | 'toc' | 'all-text',
): Chapter[] | TableOfContents[] | string {
    let accumulatedWordCount = 0

    const getChapterData = (chapter: MockChapter, index: number) => {
        let content = chapter.title ? `${chapter.title}\n\n    ${chapter.content}` : chapter.content
        content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').trim()
        content = content.replace(/<[^>]*>?/g, '').trim()
        const title = chapter.title || `Chapter ${index + 1}`
        const wordCount = content.split(/\s+/).length
        const wordStartIndex = accumulatedWordCount
        accumulatedWordCount += wordCount
        return { content, wordCount, wordStartIndex, title }
    }

    if (type === 'chapters') {
        return chapters.map((chapter, index) => {
            const { content, wordCount, wordStartIndex, title } = getChapterData(chapter, index)
            return {
                content,
                title,
                order: index,
                wordCount,
                wordStartIndex,
                id: `chapter${index + 1}`,
            }
        })
    } else if (type === 'toc') {
        return chapters.map((chapter, index) => {
            const { wordStartIndex, title } = getChapterData(chapter, index)
            return {
                title,
                href: `#chapter-chapter${index + 1}`,
                order: index,
                wordStartIndex,
            }
        })
    } else if (type === 'all-text') {
        return chapters
            .map((chapter, index) => getChapterData(chapter, index).content)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
    }
    throw new Error(`Invalid type: ${type}`)
}
