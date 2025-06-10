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

export async function fetchChapterList(url, urlType) {
    try {
        const response = await fetch("http://localhost:5000/fetch-chapters", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, type: urlType })
        });
        const chapters = await response.json();
        return chapters;
    } catch (error) {
        console.error("Error fetching chapters:", error);
        return [];
    }
}