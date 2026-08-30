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

type ManifestItem = {
    href: string
    mediaType: string
    properties?: string
}

const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/'
const EPUB_NAMESPACE = 'http://www.idpf.org/2007/ops'
const HTML_MEDIA_TYPES = new Set(['application/xhtml+xml', 'text/html'])
const BLOCK_ELEMENTS = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'DD',
    'DIV',
    'DL',
    'DT',
    'FIGCAPTION',
    'FIGURE',
    'FOOTER',
    'FORM',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'HR',
    'LI',
    'MAIN',
    'NAV',
    'OL',
    'P',
    'PRE',
    'SECTION',
    'TABLE',
    'TD',
    'TH',
    'TR',
    'UL',
])

export async function parseEpub(file: File | Blob): Promise<EpubData> {
    const zipReader = new ZipReader(new BlobReader(file))

    try {
        const entries = await zipReader.getEntries()
        const { opfPath } = await readContainer(entries)
        const opfContent = await readOpf(entries, opfPath)
        const metadata = parseMetadata(opfContent)
        const { manifest, spine } = parseManifestAndSpine(opfContent)
        const chapters = await readChapters(entries, opfPath, manifest, spine)

        const navEnhanced = await enhanceChapterTitlesFromNav(entries, opfPath, chapters, manifest)
        if (!navEnhanced) {
            await enhanceChapterTitlesFromNCX(entries, opfPath, chapters, manifest)
        }

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

    const containerDoc = parseXmlDocument(containerXml, 'container.xml')
    const rootfileElement = findFirstElementByLocalName(containerDoc, 'rootfile')

    if (!rootfileElement) throw new Error('Rootfile not found in container.xml')

    const opfPath = resolveEpubPath('', rootfileElement.getAttribute('full-path') || '')
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
    const opfDoc = parseXmlDocument(opfContent, 'OPF')
    const metadataElement = findFirstElementByLocalName(opfDoc, 'metadata')
    const titleElement = findMetadataElement(metadataElement, 'title')
    const authorElement = findMetadataElement(metadataElement, 'creator')
    const title = titleElement?.textContent?.trim() || ''
    const author = authorElement?.textContent?.trim() || ''

    return {
        title: title || 'Unknown Title',
        author: author || 'Unknown Author',
    }
}

function parseManifestAndSpine(opfContent: string): {
    manifest: Map<string, ManifestItem>
    spine: string[]
} {
    const opfDoc = parseXmlDocument(opfContent, 'OPF')

    const manifest = new Map<string, ManifestItem>()
    const manifestElement = findFirstElementByLocalName(opfDoc, 'manifest')
    const manifestItems = manifestElement ? getElementsByLocalName(manifestElement, 'item') : []

    manifestItems.forEach((item) => {
        const id = item.getAttribute('id')?.trim()
        const href = item.getAttribute('href')?.trim()
        const mediaType = item.getAttribute('media-type')?.trim().toLowerCase()
        const properties = item.getAttribute('properties')?.trim().toLowerCase() || undefined

        if (id && href && mediaType) {
            manifest.set(id, { href, mediaType, properties })
        }
    })

    const spine: string[] = []
    const spineElement = findFirstElementByLocalName(opfDoc, 'spine')
    const spineItems = spineElement ? getElementsByLocalName(spineElement, 'itemref') : []

    spineItems.forEach((item) => {
        const idref = item.getAttribute('idref')?.trim()
        const linear = item.getAttribute('linear')?.trim().toLowerCase()
        if (idref && linear !== 'no') {
            spine.push(idref)
        }
    })

    return { manifest, spine }
}

async function readChapters(
    entries: Entry[],
    opfPath: string,
    manifest: Map<string, ManifestItem>,
    spine: string[],
): Promise<Chapter[]> {
    const chapters: Chapter[] = []
    const basePath = getDirectoryPath(opfPath)

    for (let i = 0; i < spine.length; i++) {
        const itemId = spine[i]
        const manifestItem = manifest.get(itemId)

        if (!manifestItem || !HTML_MEDIA_TYPES.has(manifestItem.mediaType)) continue

        const fullPath = resolveEpubPath(basePath, manifestItem.href)
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

async function enhanceChapterTitlesFromNav(
    entries: Entry[],
    opfPath: string,
    chapters: Chapter[],
    manifest: Map<string, ManifestItem>,
): Promise<boolean> {
    try {
        let navHref = ''
        for (const [, item] of manifest) {
            if (item.properties?.split(/\s+/).includes('nav')) {
                navHref = item.href
                break
            }
        }

        if (!navHref) return false

        const opfBasePath = getDirectoryPath(opfPath)
        const navPath = resolveEpubPath(opfBasePath, navHref)
        const navEntry = entries.find((entry) => entry.filename === navPath)

        if (!isFileEntry(navEntry)) return false

        const textWriter = new TextWriter()
        const navContent = await navEntry.getData(textWriter)

        const parser = new DOMParser()
        let navDoc = parser.parseFromString(navContent, 'application/xhtml+xml')
        if (isXmlParserError(navDoc)) {
            navDoc = parser.parseFromString(navContent, 'text/html')
        }

        const navElements = getElementsByLocalName(navDoc, 'nav')
        const navElement = navElements.find((nav) => {
            const epubType = resolveEpubType(nav)
            const role = nav.getAttribute('role')?.trim().toLowerCase()
            const type = nav.getAttribute('type')?.trim().toLowerCase()

            return epubType?.split(/\s+/).includes('toc') || role === 'doc-toc' || type === 'toc'
        })

        if (!navElement) return false

        const navLinks = navElement.querySelectorAll('a[href]')
        if (!navLinks.length) return false

        const navBasePath = getDirectoryPath(navPath)
        const navTitles = new Map<string, string>()

        navLinks.forEach((link) => {
            const href = link.getAttribute('href')?.trim()
            const title = link.textContent?.trim()
            if (!href || !title) return

            const normalized = resolveEpubPath(navBasePath, href)
            if (normalized) {
                navTitles.set(normalized, title)
            }
        })

        let updated = false
        for (const [id, manifestItem] of manifest) {
            const chapter = chapters.find((ch) => ch.id === id)
            const normalizedManifestHref = resolveEpubPath(opfBasePath, manifestItem.href)
            if (chapter && navTitles.has(normalizedManifestHref)) {
                const navTitle = navTitles.get(normalizedManifestHref)
                if (navTitle && navTitle.length > 0) {
                    chapter.title = navTitle
                    updated = true
                }
            }
        }

        return updated
    } catch (error) {
        console.warn('Failed to parse nav file:', error)
        return false
    }
}

function resolveEpubPath(basePath: string, href: string): string {
    const pathPart = href.trim().split(/[?#]/, 1)[0]
    if (!pathPart || /^[a-z][a-z\d+.-]*:/i.test(pathPart)) return ''

    const decodedPath = safelyDecodeUriComponent(pathPart)
    if (decodedPath.includes('\0')) return ''

    const combinedPath = decodedPath.startsWith('/')
        ? decodedPath.slice(1)
        : `${basePath}${decodedPath}`
    const parts = combinedPath.split('/')
    const normalizedParts: string[] = []

    for (const part of parts) {
        if (!part || part === '.') continue
        if (part === '..') {
            if (!normalizedParts.length) return ''
            normalizedParts.pop()
            continue
        }
        normalizedParts.push(part)
    }

    return normalizedParts.join('/')
}

function safelyDecodeUriComponent(value: string): string {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

function getDirectoryPath(path: string): string {
    const slashIndex = path.lastIndexOf('/')
    return slashIndex < 0 ? '' : path.slice(0, slashIndex + 1)
}

function resolveEpubType(nav: Element): string | undefined {
    for (const attr of Array.from(nav.attributes)) {
        const name = attr.name.toLowerCase()
        if (
            name === 'epub:type' ||
            name.endsWith(':type') ||
            (attr.namespaceURI === EPUB_NAMESPACE && attr.localName?.toLowerCase() === 'type')
        ) {
            const value = attr.value.trim()
            if (value) return value.toLowerCase()
        }
    }

    return undefined
}
async function enhanceChapterTitlesFromNCX(
    entries: Entry[],
    opfPath: string,
    chapters: Chapter[],
    manifest: Map<string, ManifestItem>,
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

        const opfBasePath = getDirectoryPath(opfPath)
        const ncxPath = resolveEpubPath(opfBasePath, ncxHref)
        const ncxEntry = entries.find((entry) => entry.filename === ncxPath)

        if (!isFileEntry(ncxEntry)) return

        const textWriter = new TextWriter()
        const ncxContent = await ncxEntry.getData(textWriter)

        const ncxDoc = parseXmlDocument(ncxContent, 'NCX')
        const navPoints = getElementsByLocalName(ncxDoc, 'navPoint')
        const ncxBasePath = getDirectoryPath(ncxPath)

        const ncxTitles = new Map<string, string>()
        navPoints.forEach((navPoint) => {
            const textElement = findFirstElementByLocalName(navPoint, 'text')
            const contentElement = findFirstElementByLocalName(navPoint, 'content')

            if (textElement && contentElement) {
                const title = textElement.textContent?.trim()
                const src = contentElement.getAttribute('src')?.trim()

                if (title && src) {
                    const normalizedSrc = resolveEpubPath(ncxBasePath, src)
                    if (normalizedSrc) ncxTitles.set(normalizedSrc, title)
                }
            }
        })

        for (const [id, manifestItem] of manifest) {
            const chapter = chapters.find((ch) => ch.id === id)
            const normalizedManifestHref = resolveEpubPath(opfBasePath, manifestItem.href)
            if (chapter && ncxTitles.has(normalizedManifestHref)) {
                const ncxTitle = ncxTitles.get(normalizedManifestHref)
                if (ncxTitle && ncxTitle.length > 0) {
                    chapter.title = ncxTitle
                }
            }
        }
    } catch (error) {
        console.warn('Failed to parse NCX file:', error)
    }
}

function parseXmlDocument(xml: string, description: string): XMLDocument {
    const parser = new DOMParser()
    const document = parser.parseFromString(xml, 'text/xml')

    if (isXmlParserError(document)) {
        throw new Error(`Invalid ${description} XML`)
    }

    return document
}

function isXmlParserError(document: XMLDocument): boolean {
    return (
        document.documentElement?.localName?.toLowerCase() === 'parsererror' ||
        document.getElementsByTagName('parsererror').length > 0
    )
}

function getElementsByLocalName(parent: Document | Element, localName: string): Element[] {
    const expectedName = localName.toLowerCase()
    return Array.from(parent.getElementsByTagName('*')).filter(
        (element) => getElementLocalName(element) === expectedName,
    )
}

function findFirstElementByLocalName(
    parent: Document | Element,
    localName: string,
): Element | undefined {
    return getElementsByLocalName(parent, localName)[0]
}

function getElementLocalName(element: Element): string {
    return (element.localName || element.tagName.split(':').pop() || '').toLowerCase()
}

function findMetadataElement(
    metadata: Element | undefined,
    localName: string,
): Element | undefined {
    if (!metadata) return undefined

    const namespacedElement = metadata.getElementsByTagNameNS(DC_NAMESPACE, localName)[0]
    return namespacedElement || findFirstElementByLocalName(metadata, localName)
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

    const bodyElement = doc.querySelector('body') || doc.documentElement
    const content = extractReadableText(bodyElement).trim()

    return { title, content }
}

function extractReadableText(element: Element): string {
    const tagName = element.tagName.toUpperCase()
    if (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'NOSCRIPT') return ''

    let text = ''
    for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === 3) {
            text = appendText(text, child.nodeValue || '')
        } else if (child.nodeType === 1) {
            text = appendText(text, extractReadableText(child as Element))
        }
    }

    if (tagName === 'BR') {
        return appendText(text, '\n')
    }

    if (BLOCK_ELEMENTS.has(tagName) && text) {
        text = text.replace(/[ \t]+$/g, '')
        if (!text.endsWith('\n\n')) text += text.endsWith('\n') ? '\n' : '\n\n'
    }

    return text
}

function appendText(current: string, next: string): string {
    if (current.endsWith('\n\n') && next.startsWith('\n')) {
        return current + next.replace(/^\n+/, '')
    }
    return current + next
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
