/** Render ordinary image URLs and embedded Base64 images without showing their encoded contents. */
const HTTP_IMAGE_RE =
	/https?:\/\/[^"'<\s一-鿿]+?\.(?:png|jpe?g|gif|bmp|webp|svg)(?:\?[^\s"'<>一-鿿]*)?(?:#[^\s"'<>一-鿿]*)?/;
const DATA_IMAGE_RE = /data:image\/(?:png|jpe?g|gif|bmp|webp|svg\+xml|avif);base64,[a-z\d+/]+={0,2}/;
const IMAGE_LINK_RE = new RegExp(`${HTTP_IMAGE_RE.source}|${DATA_IMAGE_RE.source}`, 'gi');

export function transformImgLinkOfQuestion(question: string): string {
	const toImg = (text: string) => text.replace(IMAGE_LINK_RE, (img) => `<img src="${img}" />`);
	// Keep plain URLs intact: serializing them first would escape '&' to '&amp;'.
	if (!/<img[\s>]/i.test(question)) return toImg(question);

	const dom = new DOMParser().parseFromString(question, 'text/html');
	// Keep adjacent image sources separate, including signed URLs with query strings.
	for (const img of Array.from(dom.querySelectorAll('img'))) img.replaceWith(` ${img.src} `);
	return toImg(dom.documentElement.innerHTML);
}
