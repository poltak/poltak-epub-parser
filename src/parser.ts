import { ZipReader, BlobReader, TextWriter, type Entry, type FileEntry } from '@zip.js/zip.js'

export interface Chapter {
    id: string
    title: string
    content: string
    order: number
    /** Starting word (global) index for this chapter */
    wordStartIndex: number
    /** Number of words in this chapter */
    wordCount: number
}

export interface TableOfContents {
    title: string
    href: string
    order: number
    /** Starting word (global) index for navigation */
    wordStartIndex: number
}

export interface EpubData {
    title: string
    author: string
    chapters: Chapter[]
    tableOfContents: TableOfContents[]
    /** Combined text for speed reading */
    allText: string
}

export async function parseEpub(file: File | Blob): Promise<EpubData> {
    const zipReader = new ZipReader(new BlobReader(file))

    try {
        const entries = await zipReader.getEntries()
        const { opfPath } = await readContainer(entries)
        const opfContent = await readOpf(entries, opfPath)
        const metadata = parseMetadata(opfContent)
        const { manifest, spine } = parseManifestAndSpine(opfContent)
        const chapters = await readChapters(entries, opfPath, manifest, spine)

        await enhanceChapterTitlesFromNCX(entries, opfPath, chapters, manifest)
        calculateWordPositions(chapters)

        const tableOfContents = generateTableOfContents(chapters)
        const allText = combineAllText(chapters)

        return {
            title: metadata.title,
            author: metadata.author,
            chapters,
            tableOfContents,
            allText,
        }
    } finally {
        await zipReader.close()
    }
}

async function readContainer(entries: Entry[]): Promise<{ opfPath: string; containerXml: string }> {
    const containerEntry = entries.find((entry) => entry.filename === 'META-INF/container.xml')

    if (!isFileEntry(containerEntry)) {
        throw new Error('Container.xml not found')
    }

    const textWriter = new TextWriter()
    const containerXml = await containerEntry.getData(textWriter)

    const parser = new DOMParser()
    const containerDoc = parser.parseFromString(containerXml, 'text/xml')
    const rootfileElement = containerDoc.querySelector('rootfile')

    if (!rootfileElement) throw new Error('Rootfile not found in container.xml')

    const opfPath = rootfileElement.getAttribute('full-path') || ''
    if (!opfPath) throw new Error('OPF path not found')

    return { opfPath, containerXml }
}

async function readOpf(entries: Entry[], opfPath: string): Promise<string> {
    const opfEntry = entries.find((entry) => entry.filename === opfPath)

    if (!isFileEntry(opfEntry)) {
        throw new Error('OPF file not found')
    }

    const textWriter = new TextWriter()
    return opfEntry.getData(textWriter)
}

function parseMetadata(opfContent: string): { title: string; author: string } {
    const parser = new DOMParser()
    const opfDoc = parser.parseFromString(opfContent, 'text/xml')

    const titleElement = opfDoc.querySelector('metadata title, metadata dc\\:title')
    const authorElement = opfDoc.querySelector('metadata creator, metadata dc\\:creator')

    return {
        title: titleElement?.textContent || 'Unknown Title',
        author: authorElement?.textContent || 'Unknown Author',
    }
}

function parseManifestAndSpine(opfContent: string): {
    manifest: Map<string, { href: string; mediaType: string }>
    spine: string[]
} {
    const parser = new DOMParser()
    const opfDoc = parser.parseFromString(opfContent, 'text/xml')

    const manifest = new Map<string, { href: string; mediaType: string }>()
    const manifestItems = opfDoc.querySelectorAll('manifest item')

    manifestItems.forEach((item) => {
        const id = item.getAttribute('id')
        const href = item.getAttribute('href')
        const mediaType = item.getAttribute('media-type')

        if (id && href && mediaType) {
            manifest.set(id, { href, mediaType })
        }
    })

    const spine: string[] = []
    const spineItems = opfDoc.querySelectorAll('spine itemref')

    spineItems.forEach((item) => {
        const idref = item.getAttribute('idref')
        if (idref) {
            spine.push(idref)
        }
    })

    return { manifest, spine }
}

async function readChapters(
    entries: Entry[],
    opfPath: string,
    manifest: Map<string, { href: string; mediaType: string }>,
    spine: string[],
): Promise<Chapter[]> {
    const chapters: Chapter[] = []
    const basePath = opfPath.substring(0, opfPath.lastIndexOf('/') + 1)

    for (let i = 0; i < spine.length; i++) {
        const itemId = spine[i]
        const manifestItem = manifest.get(itemId)

        if (!manifestItem || !manifestItem.mediaType.includes('html')) continue

        const fullPath = basePath + manifestItem.href
        const chapterEntry = entries.find((entry) => entry.filename === fullPath)

        if (!isFileEntry(chapterEntry)) continue

        const textWriter = new TextWriter()
        const chapterHtml = await chapterEntry.getData(textWriter)
        const { title, content } = extractTextFromHtml(chapterHtml)

        const words = content.split(/\s+/).filter((word) => word.trim().length > 0)

        chapters.push({
            id: itemId,
            title: title || `Chapter ${i + 1}`,
            content,
            order: i,
            wordStartIndex: 0,
            wordCount: words.length,
        })
    }

    return chapters
}

async function enhanceChapterTitlesFromNCX(
    entries: Entry[],
    opfPath: string,
    chapters: Chapter[],
    manifest: Map<string, { href: string; mediaType: string }>,
): Promise<void> {
    try {
        let ncxHref = ''
        for (const [, item] of manifest) {
            if (item.mediaType === 'application/x-dtbncx+xml') {
                ncxHref = item.href
                break
            }
        }

        if (!ncxHref) return

        const basePath = opfPath.substring(0, opfPath.lastIndexOf('/') + 1)
        const fullPath = basePath + ncxHref
        const ncxEntry = entries.find((entry) => entry.filename === fullPath)

        if (!isFileEntry(ncxEntry)) return

        const textWriter = new TextWriter()
        const ncxContent = await ncxEntry.getData(textWriter)

        const parser = new DOMParser()
        const ncxDoc = parser.parseFromString(ncxContent, 'text/xml')
        const navPoints = ncxDoc.querySelectorAll('navPoint')

        const ncxTitles = new Map<string, string>()
        navPoints.forEach((navPoint) => {
            const textElement = navPoint.querySelector('text')
            const contentElement = navPoint.querySelector('content')

            if (textElement && contentElement) {
                const title = textElement.textContent?.trim()
                const src = contentElement.getAttribute('src')

                if (title && src) {
                    const cleanSrc = src.split('#')[0]
                    ncxTitles.set(cleanSrc, title)
                }
            }
        })

        for (const [id, manifestItem] of manifest) {
            const chapter = chapters.find((ch) => ch.id === id)
            if (chapter && ncxTitles.has(manifestItem.href)) {
                const ncxTitle = ncxTitles.get(manifestItem.href)
                if (ncxTitle && ncxTitle.length > 0) {
                    chapter.title = ncxTitle
                }
            }
        }
    } catch (error) {
        console.warn('Failed to parse NCX file:', error)
    }
}

function calculateWordPositions(chapters: Chapter[]): void {
    let currentWordIndex = 0

    chapters.forEach((chapter) => {
        chapter.wordStartIndex = currentWordIndex
        currentWordIndex += chapter.wordCount
    })
}

function extractTextFromHtml(html: string): { title: string; content: string } {
    const parser = new DOMParser()
    const doc = parser.parseFromString(html, 'text/html')

    let title = ''

    const metaTitle = doc.querySelector('meta[name="title"], meta[property="dc:title"]')
    if (metaTitle) {
        title = metaTitle.getAttribute('content')?.trim() || ''
    }

    if (!title) {
        const headings = doc.querySelectorAll(
            'h1, h2, h3, .chapter-title, .section-title, [class*="title"], [class*="chapter"], [class*="heading"]',
        )
        for (const heading of headings) {
            const headingText = heading.textContent?.trim() || ''
            if (headingText && headingText.length > 0 && headingText.length < 200) {
                title = headingText
                break
            }
        }
    }

    if (!title) {
        const titleElement = doc.querySelector('title')
        if (titleElement) {
            title = titleElement.textContent?.trim() || ''
        }
    }

    if (!title) {
        const firstParagraphs = doc.querySelectorAll('p, div')
        for (const p of firstParagraphs) {
            const text = p.textContent?.trim() || ''
            if (text && text.length > 3 && text.length < 100 && !text.includes('.')) {
                title = text
                break
            }
        }
    }

    title = title
        .replace(/^\d+\.\s*/, '')
        .replace(/^Chapter\s+\d+\s*/i, '')
        .replace(/^Section\s+\d+\s*/i, '')
        .trim()

    const scripts = doc.querySelectorAll('script, style')
    scripts.forEach((script) => script.remove())

    const bodyElement = doc.querySelector('body') || doc.documentElement
    const content = bodyElement.textContent?.trim() || ''

    return { title, content }
}

function generateTableOfContents(chapters: Chapter[]): TableOfContents[] {
    return chapters.map((chapter, index) => ({
        title: chapter.title,
        href: `#chapter-${chapter.id}`,
        order: index,
        wordStartIndex: chapter.wordStartIndex,
    }))
}

function combineAllText(chapters: Chapter[]): string {
    return chapters
        .map((chapter) => chapter.content)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function isFileEntry(entry: Entry | undefined): entry is FileEntry {
    return Boolean(entry) && entry?.directory !== true
}
