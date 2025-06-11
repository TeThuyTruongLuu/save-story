import os
import json
import requests
from bs4 import BeautifulSoup
from seleniumwire import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import time
import subprocess
import zipfile
from urllib.parse import urljoin, urlparse
from flask import Flask, request, jsonify, send_file, send_from_directory
import re
import io
import shutil
from threading import Lock
from flask_cors import CORS
from docx import Document
from docx.shared import Inches
import unicodedata
from selenium.common.exceptions import TimeoutException

app = Flask(__name__)
CORS(app)

os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"

selector_configs = {
    "lofter.com": {
        "post_list": ["div.m-post", "div.post", "article.post", "div.g-post"],
        "post_url": ["a[href*='.lofter.com/post/']"],
        "title": ["h2", "div.ttl", "div.title", "a.title", "h3"],
        "content": [
            "div.txt",
            "div.content",
            "div.text",
            "div.post-content",
            "div.g-ctc",
            "div.entry-content",
            "div.wrap + div.txt",
            "div.wrap + div.content",
            "div.wrap + div.text",
            "div.wrap",
        ],
        "images": ["div.m-post img", "img.postimg", "div.img img", "div.g-img img", "div.entry-content img"]
    }
}

lofter_cookies = None
cookie_lock = Lock()
driver_lock = Lock()
driver = None  # Tái sử dụng driver

def setup_selenium():
    global driver
    with driver_lock:
        if driver is None or not driver.session_id:
            options = Options()
            options.add_argument("--headless")
            options.add_argument("--disable-gpu")
            options.add_argument("--no-sandbox")
            options.add_argument("--disable-dev-shm-usage")
            options.add_argument("--disable-blink-features=AutomationControlled")
            options.add_experimental_option("excludeSwitches", ["enable-automation"])
            driver = webdriver.Chrome(options=options)
        return driver

def load_lofter_cookies(driver, cookie_file="lofter_cookies.json"):
    global lofter_cookies
    with cookie_lock:
        if lofter_cookies is None:
            try:
                with open(cookie_file, "r") as f:
                    lofter_cookies = json.load(f)
            except FileNotFoundError:
                print("Không tìm thấy file cookie Lofter.")
                return False
        
        current_time = time.time()
        valid_cookies = [cookie for cookie in lofter_cookies if cookie.get("expires", -1) == -1 or cookie["expires"] > current_time]
        if not valid_cookies:
            print("Cookie Lofter đã hết hạn. Vui lòng cập nhật cookie mới.")
            return False
        
        driver.get("https://www.lofter.com")
        for cookie in valid_cookies:
            driver.add_cookie(cookie)
        driver.refresh()
        print("Đã tải cookie Lofter hợp lệ.")
        return True

def save_lofter_cookies(driver, cookie_file="lofter_cookies.json"):
    with open(cookie_file, "w") as f:
        json.dump(driver.get_cookies(), f)
    print("Saved Lofter cookies.")

def parse_by_selector(post_elem, selector_set, index_in_list=0):
    result = {}
    
    for sel in selector_set.get("content", []):
        elem = post_elem.select_one(sel)
        if elem:
            for span in elem.select("span.picNum"):
                span.decompose()

            result["content"] = elem.decode_contents().strip()
            result["content_text"] = elem.get_text(separator=" ", strip=True)
            break

    if "content" not in result:
        result["content"] = "Không tìm thấy nội dung"
        result["content_text"] = "Không tìm thấy nội dung"
    
    import html

    result["images"] = []
    for sel in selector_set.get("images", []):
        imgs = post_elem.select(sel)
        if imgs:
            result["images"] = [
                html.unescape(img["src"]) if img["src"].startswith("http") else "https:" + html.unescape(img["src"])
                for img in imgs if "src" in img.attrs
            ]
            break

    
    for sel in selector_set.get("title", []):
        elem = post_elem.select_one(sel)
        if elem and elem.text.strip():
            result["title"] = elem.text.strip()
            break
    if "title" not in result or not result["title"].strip():
        first_img = post_elem.select_one("img")
        if first_img and first_img.get("alt"):
            result["title"] = first_img["alt"].strip()
        elif result.get("content_text", "").strip():
            # Nếu có content_text → lấy làm title fallback
            result["title"] = result["content_text"][:40].strip()
        else:
            result["title"] = f"Bài số {index_in_list}"
    
    return result


def download_images(images, post_id):
    downloaded_images = []
    os.makedirs("temp/images", exist_ok=True)
    
    for i, img_url in enumerate(images):
        try:
            response = requests.get(img_url, stream=True, timeout=10)
            response.raise_for_status()
            img_path = f"temp/images/{post_id}_{i}.jpg"
            with open(img_path, "wb") as f:
                f.write(response.content)
            downloaded_images.append(img_path)
        except Exception as e:
            print(f"Không thể tải hình ảnh {img_url}: {e}")
            downloaded_images.append(None)
    
    return downloaded_images

def fetch_ao3_works(url, driver):
    driver.get(url)
    works = []
    while True:
        soup = BeautifulSoup(driver.page_source, "html.parser")
        for work in soup.select("li.work"):
            title = work.select_one("h4.heading a").text.strip()
            work_url = urljoin("https://archiveofourown.org", work.select_one("h4.heading a")["href"])
            works.append({"title": title, "url": work_url})
        try:
            next_button = driver.find_element(By.CSS_SELECTOR, "a[rel='next']")
            next_button.click()
            WebDriverWait(driver, 5).until(EC.presence_of_element_located((By.CSS_SELECTOR, "li.work")))
        except:
            break
    return works

def fetch_lofter_posts(url, driver, is_tag=False, max_posts=50, wait_time=1, continue_fetch=False):
    driver.get(url)
    if not load_lofter_cookies(driver):
        return []
    driver.get(url)
    driver.set_page_load_timeout(30)
    time.sleep(2)  # Giảm xuống 2 giây

    posts = []
    last_height = driver.execute_script("return document.body.scrollHeight")

    if continue_fetch:
        driver.get(url)
        time.sleep(2)

    for _ in range(5):  # Giảm số lần cuộn tối đa
        try:
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
            WebDriverWait(driver, wait_time).until(
                lambda d: d.execute_script("return document.body.scrollHeight") != last_height
            )
            new_height = driver.execute_script("return document.body.scrollHeight")
            if new_height == last_height or len(posts) >= max_posts:
                break
            last_height = new_height
        except TimeoutException:
            break
        except Exception as e:
            print(f"Error during scroll: {e}")
            break

    soup = BeautifulSoup(driver.page_source, "html.parser")
    domain = urlparse(url).netloc
    selector_set = {
        "content": ["div.txt", "div.content", "div.text", "div.post-content", "div.g-ctc", "div.entry-content", "div.wrap + div.text"],
        "images": ["img"],
        "title": ["h1", "h2", "div.ttl", "div.title"]
    }


    print(f"Found {len(soup.select(', '.join(selector_set.get('post_list', ['div.m-post']))))} post elements")
    for post_elem in soup.select(", ".join(selector_set.get("post_list", ["div.m-post"]))):
        if len(posts) >= max_posts:
            break
        post_url_elem = post_elem.select_one(", ".join(selector_set.get("post_url", ["a[href*='.lofter.com/post/']"])))
        post_url = urljoin(url, post_url_elem["href"]) if post_url_elem else ""

        parsed = parse_by_selector(post_elem, selector_set, len(posts)+1)
        post_id = post_url.split("/")[-1] if post_url else f"post_{len(posts)}"
        downloaded_images = download_images([urljoin(url, img) for img in parsed["images"]], post_id)

        if post_url and post_url not in [p["url"] for p in posts]:
            posts.append({
                "title": parsed["title"],
                "url": post_url,
                "content": parsed["content"],
                "images": downloaded_images,
                "preview": parsed.get("content_text", "")[:40].strip() if parsed.get("content_text") else ""
            })

    next_link = soup.select_one("a.next, a.next-page")
    if next_link and is_tag and len(posts) < max_posts:
        next_url = urljoin(url, next_link["href"])
        posts.extend(fetch_lofter_posts(next_url, driver, is_tag, max_posts, wait_time))

    with open("temp/page_source.html", "w", encoding="utf-8") as f:
        f.write(driver.page_source)
    print(f"Total posts found: {len(posts)}")
    for post in posts:
        print(f"Title: {post['title']}")
        print(f"Content: {post['content'][:100]}...")
        print(f"Images: {post['images']}")
        print(f"Preview: {post['preview']}")

    return posts

def fetch_forum_chapters(url, driver):
    driver.get(url)
    soup = BeautifulSoup(driver.page_source, "html.parser")
    main_title = soup.select_one("h1.p-title-value").text.strip() if soup.select_one("h1.p-title-value") else "Forum Thread"

    chapters = []
    for idx, article in enumerate(soup.select("article.message")):
        content_div = article.select_one("div.bbWrapper")
        user_link = article.select_one("h4.message-name a.username")

        if content_div and user_link:
            username = user_link.text.strip()
            content_html = content_div.decode_contents()
            content_text = BeautifulSoup(content_html, "html.parser").get_text(separator=" ", strip=True)
            preview = content_text[:20] + "..." if len(content_text) > 20 else content_text
            title = f"{username}: {preview}"

            chapters.append({
                "title": title,
                "content": content_html,
                "images": []  # Placeholder
            })

    return {"main_title": main_title, "chapters": chapters}

def download_content(url, driver):
    driver.get(url)
    load_lofter_cookies(driver)
    driver.set_page_load_timeout(60)

    try:
        driver.get(url)
    except TimeoutException:
        print(f"Timeout khi tải {url}, bỏ qua")
        return {
            "title": "Timeout",
            "text": "",
            "images": []
        }


    time.sleep(2)
    soup = BeautifulSoup(driver.page_source, "html.parser")

    domain = urlparse(url).netloc
    selector_set = {
        "content": [
            "div.txt",
            "div.content",
            "div.text",
            "div.post-content",
            "div.g-ctc",
            "div.entry-content",
            "div.wrap + div.txt",
            "div.wrap + div.content",
            "div.wrap + div.text",
            "div.wrap",  # fallback cuối cùng
        ],
        "images": ["img"],
        "title": ["h1", "h2", "div.ttl", "div.title"]
    }


    parsed = parse_by_selector(soup, selector_set)
    post_id = url.split("/")[-1]
    downloaded_images = download_images([urljoin(url, img) for img in parsed["images"]], post_id)

    content = {
        "title": parsed["title"],
        "text": parsed["content"],
        "images": downloaded_images
    }

    return content

def create_html(chapters, main_title):
    html = f"""
    <html>
    <head>
        <meta charset="UTF-8">
        <title>{main_title}</title>
    </head>
    <body>
        <h1>{main_title}</h1>
        <ul>
    """
    for idx, chapter in enumerate(chapters):
        html += f'<li><a href="#chapter{idx+1}">{chapter["title"]}</a></li>'

    html += "</ul>"

    for idx, chapter in enumerate(chapters):
        html += f'<h2 id="chapter{idx+1}">{chapter["title"]}</h2>'
        html += f'<div>{chapter["content"]}</div>'
        for img in chapter.get("images", []):
            if img and os.path.exists(img):
                img_rel_path = os.path.relpath(img, "temp").replace("\\", "/")
                html += f'<img src="{img_rel_path}" alt="Image" style="max-width:100%;"><br>'

    html += "</body></html>"

    os.makedirs("temp", exist_ok=True)
    safe_main_title = sanitize_filename(main_title)
    html_file = f"temp/{safe_main_title}.html"
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(html)
    return html_file

def convert_to_format(html_file, output_format, main_title):
    output_file = f"temp/{main_title}.{output_format}"

    if output_format == "epub":
        subprocess.run([
            "pandoc", html_file, "-o", output_file,
            "--metadata", f"title={main_title}",
            "--resource-path=temp/images"
        ], check=True)

    elif output_format == "pdf":
        subprocess.run([
            "wkhtmltopdf", "--enable-local-file-access", html_file, output_file
        ], check=True)

    elif output_format == "docx":
        doc = Document()
        doc.add_heading(main_title, 0)

        with open(html_file, "r", encoding="utf-8") as f:
            soup = BeautifulSoup(f, "html.parser")

        for element in soup.find_all(["h2", "p", "img"]):
            if element.name == "h2":
                doc.add_heading(element.text, level=2)
            elif element.name == "p":
                doc.add_paragraph(element.text)
            elif element.name == "img" and element.get("src"):
                try:
                    img_path = element["src"].replace("file://", "")
                    if os.path.exists(img_path):
                        doc.add_picture(img_path, width=Inches(5.0))
                except Exception as e:
                    print(f"Không thể thêm hình ảnh {element['src']}: {e}")

    elif output_format == "rar":
        output_zip = f"temp/{main_title}.zip"
        with zipfile.ZipFile(output_zip, "w") as zf:
            zf.write(html_file, arcname=os.path.basename(html_file))
            for img in os.listdir("temp/images"):
                if img.endswith(".jpg"):
                    zf.write(os.path.join("temp/images", img), arcname=img)
        os.rename(output_zip, output_file)

    else:
        raise ValueError(f"Định dạng {output_format} không được hỗ trợ.")

    return output_file

def cleanup_temp():
    if os.path.exists("temp"):
        shutil.rmtree("temp")

def sanitize_filename(filename):
    filename = unicodedata.normalize("NFD", filename)
    filename = filename.encode("ascii", "ignore").decode("utf-8")
    filename = filename.replace('đ', 'd').replace('Đ', 'D')
    filename = re.sub(r'[^A-Za-z0-9 ]', '', filename)
    filename = re.sub(r'\s+', '_', filename)
    filename = filename.strip('_')
    return filename

@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({"status": "Server is running"})

@app.route("/fetch-chapters", methods=["POST"])
def fetch_chapters():
    data = request.get_json()
    url = data.get('url')
    url_type = data.get('type')
    max_posts = data.get('max_posts', 50)
    wait_time = data.get('wait_time', 1)  # Giảm mặc định xuống 1 giây
    continue_fetch = data.get('continue_fetch', False)
    driver = setup_selenium()

    try:
        if url_type == "ao3_tag":
            items = fetch_ao3_works(url, driver)
            return jsonify(items)
        elif url_type in ["lofter_author", "lofter_tag"]:
            items = fetch_lofter_posts(url, driver, url_type == "lofter_tag", max_posts, wait_time, continue_fetch)
            if not items:
                return jsonify({"error": "Không tìm thấy bài viết"}), 400
            return jsonify(items)
        elif url_type == "forum":
            result = fetch_forum_chapters(url, driver)
            return jsonify(result)
        else:
            return jsonify({"error": "Invalid URL type"}), 400
    finally:
        # Không quit driver để tái sử dụng
        pass

@app.route("/download", methods=["POST"])
def download():
    data = request.get_json()
    driver = setup_selenium()

    try:
        if data.get("type") == "forum":
            main_title = data.get("main_title", "Forum Thread")
            chapters = data.get("chapters", [])
            output_format = data.get("format", "epub").lower()
            safe_main_title = sanitize_filename(main_title)
            html_file = create_html(chapters, safe_main_title)
            output_file = convert_to_format(html_file, output_format, safe_main_title)

            with open(output_file, "rb") as f:
                file_data = f.read()
            file_name = os.path.basename(output_file)
            cleanup_temp()
            return send_file(
                io.BytesIO(file_data),
                as_attachment=True,
                download_name=file_name,
                mimetype=f"application/{'vnd.openxmlformats-officedocument.wordprocessingml.document' if output_format == 'docx' else output_format}"
            )

        urls = data.get("urls", [])
        output_format = data.get("format", "epub").lower()
        main_title = data.get("main_title", "Lofter Posts")

        if any("lofter.com" in url for url in urls):
            load_lofter_cookies(driver)

        chapters = []
        for url in urls:
            content = download_content(url, driver)
            chapters.append({
                "title": content["title"],
                "content": content["text"],
                "images": content["images"]
            })

        safe_main_title = sanitize_filename(main_title)
        html_file = create_html(chapters, safe_main_title)
        output_file = convert_to_format(html_file, output_format, safe_main_title)

        with open(output_file, "rb") as f:
            file_data = f.read()
        file_name = os.path.basename(output_file)
        cleanup_temp()
        return send_file(
            io.BytesIO(file_data),
            as_attachment=True,
            download_name=file_name,
            mimetype=f"application/{'vnd.openxmlformats-officedocument.wordprocessingml.document' if output_format == 'docx' else output_format}"
        )
    finally:
        # Không quit driver để tái sử dụng
        pass

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

if __name__ == "__main__":
    try:
        app.run(debug=True, host="0.0.0.0", port=5000, threaded=True)
    finally:
        if driver:
            driver.quit()  # Quit driver khi ứng dụng dừng