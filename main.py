from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import os
from ebooklib import epub
import logging
import tempfile
import requests
from bs4 import BeautifulSoup
import re
import unicodedata

logging.basicConfig(level=logging.DEBUG)

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

@app.after_request
def apply_cors_headers(response):
    print("RESPONSE HEADERS", response.headers)
    return response

@app.errorhandler(Exception)
def handle_exception(e):
    app.logger.error(f"Global error: {str(e)}")
    return jsonify({'error': 'Lỗi server nội bộ', 'details': str(e)}), 500

@app.route("/")
def hello():
    return "✅ API running ngon lành!"

def convert_title_to_filename(title):
    nfkd_form = unicodedata.normalize('NFKD', title)
    ascii_form = nfkd_form.encode('ASCII', 'ignore').decode('utf-8')
    ascii_form = re.sub(r"[^\w\s]", '', ascii_form)
    ascii_form = re.sub(r"\s+", '_', ascii_form.strip())
    return ascii_form.lower() + '.epub'

@app.route('/api/crawl', methods=['POST'])
def crawl_thread():
    try:
        data = request.get_json()
        url = data.get('url')
        if not url:
            return jsonify({'error': 'Thiếu URL'}), 400
        res = requests.get(url)
        res.encoding = 'utf-8'
        soup = BeautifulSoup(res.text, 'html.parser')
        title_tag = soup.find('title')
        title = title_tag.get_text(strip=True) if title_tag else 'Không rõ tiêu đề'
        articles = soup.select('article[data-author]')
        chapters = []
        for idx, article in enumerate(articles, 1):
            author = article.get('data-author', f'Tác giả {idx}')
            content_div = article.select_one('div.bbWrapper')
            if not content_div:
                continue
            content_html = str(content_div)
            chapters.append({
                'title': f'Reply {idx}: {author}',
                'content': content_html
            })
        response = jsonify({
            'title': title,
            'chapters': chapters
        })
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response
    except Exception as e:
        app.logger.error(f"Lỗi crawl thread: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/crawl_multi', methods=['POST'])
def crawl_multi():
    try:
        data = request.get_json()
        urls = data.get('urls', [])
        if not urls:
            return jsonify({'error': 'Thiếu URLs'}), 400

        chapters = []
        for idx, url in enumerate(urls, 1):
            res = requests.get(url)
            res.encoding = 'utf-8'
            soup = BeautifulSoup(res.text, 'html.parser')

            # Lấy title bài
            title_tag = soup.find('title')
            title = title_tag.get_text(strip=True) if title_tag else f'Bài {idx}'

            # Lấy content bài
            content_div = (
                soup.select_one('div.post div.post-content')
                or soup.select_one('div.js-post div.post-content')
                or soup.select_one('div.post-content')
                or soup.select_one('div.js-post')
                or soup.select_one('div.main div.content div.text')
                or soup.select_one('div.content div.text')
                or soup.select_one('div.content')  # fallback cuối cùng
            )

            if not content_div:
                continue

            # Sửa ảnh lazy load
            for img in content_div.find_all('img'):
                src = img.get('data-origin-src') or img.get('src')
                if src:
                    img['src'] = src

            content_html = str(content_div)

            chapters.append({
                'title': title,
                'content': content_html
            })

        response = jsonify({
            'title': f'Lofter Blog ({len(chapters)} bài)',
            'chapters': chapters
        })
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response
    except Exception as e:
        app.logger.error(f"Lỗi crawl multi: {str(e)}")
        return jsonify({'error': str(e)}), 500


@app.route('/api/epub', methods=['POST', 'OPTIONS'])
def epub_handler():
    if request.method == 'OPTIONS':
        return '', 204
    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Không có dữ liệu JSON'}), 400
        title = data.get('title', 'Truyen Khong Ten')
        chapters = data.get('chapters', [])
        if not chapters:
            return jsonify({'error': 'Không có chương nào'}), 400
        book = epub.EpubBook()
        book.set_title(title)
        book.set_language('vi')
        epub_chapters = []
        for idx, chapter in enumerate(chapters, 1):
            chap_title = chapter.get('title', f'Chương {idx}')
            chap_content = chapter.get('content', '')
            c = epub.EpubHtml(title=chap_title, file_name=f'chap_{idx}.xhtml', lang='vi')
            c.content = f'<h1>{chap_title}</h1><p>{chap_content.replace("\n", "<br/>")}</p>'
            book.add_item(c)
            epub_chapters.append(c)
        book.toc = tuple(epub_chapters)
        book.add_item(epub.EpubNav())
        book.spine = ['nav'] + epub_chapters
        clean_filename = convert_title_to_filename(title)
        output_path = os.path.join(tempfile.gettempdir(), clean_filename)
        epub.write_epub(output_path, book)
        return jsonify({'download_url': f'/download/{clean_filename}'})
    except Exception as e:
        app.logger.error(f"Lỗi tạo EPUB: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/download/<filename>', methods=['GET', 'OPTIONS'])
def download_file(filename):
    if request.method == 'OPTIONS':
        return '', 204
    try:
        response = send_from_directory(tempfile.gettempdir(), filename, as_attachment=True)
        response.headers['Access-Control-Allow-Origin'] = '*'
        return response
    except Exception as e:
        app.logger.error(f"Lỗi tải file: {str(e)}")
        return jsonify({'error': 'Không tìm thấy file'}), 404

if __name__ == '__main__':
    port = 5000
    app.run(host='0.0.0.0', port=port, debug=True)
