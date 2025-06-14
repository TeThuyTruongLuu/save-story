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

export async function fetchChapterList(url, urlType, maxPosts = 50) {
    const proxyUrl = "https://api.allorigins.win/raw?url=";
    let chapters = [];

    try {
        const cookies = (urlType === "lofter_author" || urlType === "lofter_tag") ? await getLofterCookies() : [];
        if ((urlType === "lofter_author" || urlType === "lofter_tag") && !cookies.length) {
            alert("Vui lòng đăng nhập Lofter và lưu cookies!");
            return [];
        }

        // ✅ Nếu là post cụ thể thì trả về luôn 1 chương, khỏi cần vòng while
        if (url.match(/\.lofter\.com\/post\//)) {
            console.log(`Fetching single post: ${url}`);
            let headers = {};
            if (cookies.length) {
                headers["Cookie"] = cookies.map(c => `${c.name}=${c.value}`).join("; ");
            }

            let response = await fetch(proxyUrl + encodeURIComponent(url), { headers });
            if (!response.ok) throw new Error(`HTTP error ${response.status}`);

            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, "text/html");

            const postTitle = doc.querySelector("title")?.textContent.trim() || "Untitled";
            return [{ title: postTitle, url: url }];
        }

        // Nếu không phải post cụ thể thì vòng while như cũ
        let nextUrl = url;
        while (nextUrl && chapters.length < maxPosts) {
            console.log(`Fetching page: ${nextUrl}`);
            let headers = {};
            if (cookies.length) {
                headers["Cookie"] = cookies.map(c => `${c.name}=${c.value}`).join("; ");
            }

            let response = await fetch(proxyUrl + encodeURIComponent(nextUrl), { headers });
            if (!response.ok) throw new Error(`HTTP error ${response.status}`);

            const text = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, "text/html");

            if (urlType === "lofter_author" || urlType === "lofter_tag") {
                const pageChapters = Array.from(doc.querySelectorAll('a[href*=".lofter.com/post/"]')).map(post => ({
                    title: post.textContent.trim() || "Untitled",
                    url: post.href
                }));

                for (const ch of pageChapters) {
                    if (!chapters.find(c => c.url === ch.url) && chapters.length < maxPosts) {
                        chapters.push(ch);
                    }
                }

                const nextLink = doc.querySelector("a.next")?.href
                    || doc.querySelector("div.next.active a")?.href
                    || doc.querySelector("div.m-pager a.next")?.href;

                if (nextLink && chapters.length < maxPosts) {
                    nextUrl = new URL(nextLink, nextUrl).href;
                    console.log(`Found next link: ${nextUrl}`);
                } else {
                    nextUrl = null;
                }

            } else if (urlType === "ao3_tag") {
                const works = Array.from(doc.querySelectorAll("li.work")).map(work => ({
                    title: work.querySelector("h4.heading a")?.textContent.trim() || "Untitled",
                    url: new URL(work.querySelector("h4.heading a")?.href, "https://archiveofourown.org").href
                }));
                chapters.push(...works);

                const nextLink = doc.querySelector("a[rel='next']")?.href;
                if (nextLink) {
                    nextUrl = new URL(nextLink, nextUrl).href;
                    console.log(`Found AO3 next link: ${nextUrl}`);
                } else {
                    nextUrl = null;
                }

            } else if (urlType === "forum") {
                const chapterLinks = Array.from(doc.querySelectorAll("a.chapter-link")).map(link => ({
                    title: link.textContent.trim(),
                    url: link.href
                }));
                chapters.push(...chapterLinks);

                const nextLink = doc.querySelector("a.pageNav-jump--next")?.href
                    || doc.querySelector("a.pageNavSimple-el--next")?.href;

                if (nextLink) {
                    nextUrl = new URL(nextLink, nextUrl).href;
                    console.log(`Found forum next link: ${nextUrl}`);
                } else {
                    nextUrl = null;
                }
            } else {
                console.warn(`Unsupported urlType: ${urlType}`);
                nextUrl = null;
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