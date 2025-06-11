import os
import json
import requests
from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
import time
import pandoc
import img2pdf
import zipfile
from urllib.parse import urljoin, urlparse
from flask import Flask, request, jsonify, send_file
import re
import io
import shutil

from flask_cors import CORS
app = Flask(__name__)
CORS(app)  # Cho phép tất cả các nguồn gốc

from selenium.webdriver.chrome.service import Service

def setup_selenium():
    options = Options()
    options.add_argument("--headless")  # Run in headless mode
    service = Service("chromedriver.exe")
    driver = webdriver.Chrome(service=service, options=options)
    return driver


def load_lofter_cookies(driver, cookie_file="lofter_cookies.json"):
    try:
        with open(cookie_file, "r") as f:
            cookies = json.load(f)
        driver.get("https://www.lofter.com")  # Navigate to domain first
        for cookie in cookies:
            driver.add_cookie(cookie)
        print("Loaded Lofter cookies.")
    except FileNotFoundError:
        print("Cookie file not found. Please provide Lofter cookies.")
        return False
    return True

def save_lofter_cookies(driver, cookie_file="lofter_cookies.json"):
    with open(cookie_file, "w") as f:
        json.dump(driver.get_cookies(), f)
    print("Saved Lofter cookies.")

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
            time.sleep(2)
        except:
            break
    return works

def fetch_lofter_posts(url, driver, is_tag=False):
    driver.get(url)
    load_lofter_cookies(driver)
    driver.get(url)  # Reload with cookies
    posts = []
    last_height = driver.execute_script("return document.body.scrollHeight")
    while True:
        driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(2)
        new_height = driver.execute_script("return document.body.scrollHeight")
        if new_height == last_height:
            break
        last_height = new_height
    soup = BeautifulSoup(driver.page_source, "html.parser")
    for post in soup.select("a[href*='.lofter.com/post/']"):
        post_url = post["href"]
        if post_url not in [p["url"] for p in posts]:
            posts.append({"title": post.text.strip() or "Untitled", "url": post_url})
    return posts

def fetch_forum_chapters(url, driver):
    driver.get(url)
    soup = BeautifulSoup(driver.page_source, "html.parser")

    # Lấy tiêu đề chính của trang
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
                "title": title,           # plain text
                "content": content_html   # full HTML
            })

    
    return {"main_title": main_title, "chapters": chapters}

def download_content(url, driver):
    driver.get(url)
    soup = BeautifulSoup(driver.page_source, "html.parser")
    content = {"text": "", "images": []}
    
    if "archiveofourown.org" in url:
        content["text"] = soup.select_one("div#chapters").text.strip() if soup.select_one("div#chapters") else ""
        content["images"] = [img["src"] for img in soup.select("div#chapters img")]
    elif "lofter.com" in url:
        content["text"] = soup.select_one("div.txt").text.strip() if soup.select_one("div.txt") else ""
        content["images"] = [img["src"] for img in soup.select("img")]
    elif "toanchuccaothu.com" in url:
        content["text"] = soup.select_one("div.chapter-content").text.strip() if soup.select_one("div.chapter-content") else ""
        content["images"] = [img["src"] for img in soup.select("div.chapter-content img")]
    
    # Download images
    for i, img_url in enumerate(content["images"]):
        try:
            response = requests.get(img_url)
            with open(f"temp/image_{i}.jpg", "wb") as f:
                f.write(response.content)
            content["images"][i] = f"temp/image_{i}.jpg"
        except:
            content["images"][i] = None
    return content

def create_html(chapters, main_title):
    html = f"<h1>{main_title}</h1><ul>"
    # Mục lục
    for idx, chapter in enumerate(chapters):
        html += f'<li><a href="#chapter{idx+1}">{chapter["title"]}</a></li>'
    html += "</ul>"

    # Nội dung
    for idx, chapter in enumerate(chapters):
        html += f'<h2 id="chapter{idx+1}">{chapter["title"]}</h2>'
        html += f'<div>{chapter["content"]}</div>'
    
    os.makedirs("temp", exist_ok=True)
    html_file = f"temp/{main_title}.html"
    with open(html_file, "w", encoding="utf-8") as f:
        f.write(html)
    return html_file


def convert_to_format(html_file, output_format, output_name):
    output_path = f"temp/{output_name}.{output_format}"
    if output_format == "epub":
        os.system(f"pandoc {html_file} -o {output_path}")
    elif output_format == "pdf":
        os.system(f"pandoc {html_file} -o {output_path} --pdf-engine=wkhtmltopdf")
    elif output_format == "docx":
        os.system(f"pandoc {html_file} -o {output_path}")
    elif output_format == "rar":
        with zipfile.ZipFile(f"temp/{output_name}.zip", "w") as zf:
            zf.write(html_file)
            for img in os.listdir("temp"):
                if img.startswith("image_") and img.endswith(".jpg"):
                    zf.write(os.path.join("temp", img))
        os.rename(f"temp/{output_name}.zip", output_path)
    return output_path

def cleanup_temp():
    if os.path.exists("temp"):
        shutil.rmtree("temp")

@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({"status": "Server is running"})

import unicodedata
import re

def remove_vietnamese_tones(s):
    s = unicodedata.normalize("NFD", s)
    s = s.encode("ascii", "ignore").decode("utf-8")
    s = s.replace('đ', 'd').replace('Đ', 'D')
    return s

def sanitize_filename(filename):
    filename = remove_vietnamese_tones(filename)
    filename = re.sub(r'[^A-Za-z0-9 ]', '', filename)
    filename = re.sub(r'\s+', '_', filename)
    filename = filename.strip('_')
    return filename




@app.route("/fetch-chapters", methods=["POST"])
def fetch_chapters():
    data = request.json
    url = data.get("url")
    url_type = data.get("type")  # "ao3_tag", "lofter_author", "lofter_tag", "forum"
    driver = setup_selenium()
    
    try:
        if url_type == "ao3_tag":
            items = fetch_ao3_works(url, driver)
            return jsonify(items)
        elif url_type in ["lofter_author", "lofter_tag"]:
            items = fetch_lofter_posts(url, driver, url_type == "lofter_tag")
            return jsonify(items)
        elif url_type == "forum":
            result = fetch_forum_chapters(url, driver)
            return jsonify(result)
        else:
            return jsonify({"error": "Invalid URL type"}), 400
    finally:
        driver.quit()


@app.route("/download", methods=["POST"])
def download():
    data = request.json
    driver = setup_selenium()

    try:
        if data.get("type") == "forum":
            main_title = data.get("main_title", "Forum Thread")
            chapters = data.get("chapters", [])
            output_format = data.get("format")

            html_file = create_html(chapters, main_title)
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
                mimetype=f"application/{output_format}"
            )

        # Còn lại: url list (ao3/lofter)
        urls = data.get("urls")
        output_format = data.get("format")

        if any("lofter.com" in url for url in urls):
            load_lofter_cookies(driver)

        files = []
        for url in urls:
            content = download_content(url, driver)
            title = re.sub(r'[^\w\s]', '', urlparse(url).path).replace('/', '_')
            html_file = create_html([{"title": title, "content": content["text"]}], title)
            safe_title = sanitize_filename(title)
            html_file = create_html([{"title": safe_title, "content": content["text"]}], safe_title)
            output_file = convert_to_format(html_file, output_format, safe_title)
            files.append(output_file)

        with open(files[0], "rb") as f:
            file_data = f.read()
        file_name = os.path.basename(files[0])
        cleanup_temp()
        return send_file(
            io.BytesIO(file_data),
            as_attachment=True,
            download_name=file_name,
            mimetype=f"application/{output_format}"
        )
    finally:
        driver.quit()
        cleanup_temp()


from flask import send_from_directory

@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
    