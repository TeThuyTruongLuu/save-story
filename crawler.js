// crawler.js - tách phần tải truyện

export async function autoFillLofterLinks() {
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
    const proxyUrl = "https://api.allorigins.win/raw?url=";
    let chapters = [];

    try {
        if (urlType === "lofter_author" || urlType === "lofter_tag") {
            const cookies = await getLofterCookies();
            if (!cookies.length) {
                alert("Vui lòng đăng nhập Lofter và lưu cookies!");
                return [];
            }

            let response = await fetch(proxyUrl + encodeURIComponent(url), {
                headers: {
                    "Cookie": cookies.map(c => `${c.name}=${c.value}`).join("; ")
                }
            });
            if (!response.ok) throw new Error(`HTTP error ${response.status}`);
            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, "text/html");

            chapters = Array.from(doc.querySelectorAll('a[href*=".lofter.com/post/"]')).map(post => ({
                title: post.textContent.trim() || "Untitled",
                url: post.href
            }));

            // Xử lý cuộn trang (giả lập bằng cách lấy thêm trang nếu có)
            const nextLink = doc.querySelector("a.next")?.href;
            if (nextLink) {
                const nextChapters = await fetchChapterList(nextLink, urlType);
                chapters.push(...nextChapters);
            }
        } else {
            // Xử lý AO3 và Forum như trước
            let nextUrl = url;
            while (nextUrl) {
                const response = await fetch(proxyUrl + encodeURIComponent(nextUrl));
                if (!response.ok) throw new Error(`HTTP error ${response.status}`);
                const text = await response.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, "text/html");

                if (urlType === "ao3_tag") {
                    const works = Array.from(doc.querySelectorAll("li.work")).map(work => ({
                        title: work.querySelector("h4.heading a")?.textContent.trim() || "Untitled",
                        url: new URL(work.querySelector("h4.heading a")?.href, "https://archiveofourown.org").href
                    }));
                    chapters.push(...works);
                    const nextLink = doc.querySelector("a[rel='next']")?.href;
                    nextUrl = nextLink ? new URL(nextLink, "https://archiveofourown.org").href : null;
                } else if (urlType === "forum") {
                    const chapterLinks = Array.from(doc.querySelectorAll("a.chapter-link")).map(link => ({
                        title: link.textContent.trim(),
                        url: link.href
                    }));
                    chapters.push(...chapterLinks);
                    nextUrl = null;
                }
            }
        }
        return chapters;
    } catch (error) {
        console.error("Error fetching chapters:", error);
        return [];
    }
}

async function getLofterCookies() {
    return new Promise((resolve) => {
        const request = indexedDB.open("StoryDB");
        request.onsuccess = (event) => {
            const db = event.target.result;
            const transaction = db.transaction(["cookies"], "readonly");
            const store = transaction.objectStore("cookies");
            const getRequest = store.get("lofter");
            getRequest.onsuccess = (e) => resolve(e.target.result?.cookies || []);
            getRequest.onerror = () => resolve([]);
        };
        request.onerror = () => resolve([]);
    });
}

export async function saveLofterCookies(cookies) {
    const request = indexedDB.open("StoryDB");
    request.onsuccess = (event) => {
        const db = event.target.result;
        const transaction = db.transaction(["cookies"], "readwrite");
        const store = transaction.objectStore("cookies");
        store.put({ id: "lofter", cookies });
    };
}