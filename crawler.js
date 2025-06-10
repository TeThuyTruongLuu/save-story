// crawler.js - tách phần tải truyện

export function autoFillLofterLinks() {
	const url = window.location.href;
	if (!url.includes('.lofter.com')) return;
	const postLinks = Array.from(document.querySelectorAll('a[href*=".lofter.com/post/"]')).map(a => a.href);
	const uniqueLinks = [...new Set(postLinks)];
	if (uniqueLinks.length > 0) {
		console.log(`Auto-fill ${uniqueLinks.length} links từ trang tác giả.`);
		document.getElementById('epubUrl').value = uniqueLinks.join('\n');
	}
}
