// storage.js - lưu trữ truyện
import { db } from './firebase.js';
import * as storage from './main.js';
import { displayStoryDetails } from './main.js';
import { collection, getDocs, query, where, doc, getDoc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

const storiesCollection = collection(db, "stories");
const downloadedStoriesCollection = collection(db, "downloaded_stories");

let allTags = [];

export let idb;

if (!window.indexedDB && !window.mozIndexedDB && !window.webkitIndexedDB && !window.msIndexedDB) {
  console.error("Trình duyệt không hỗ trợ IndexedDB.");
} else {
  const request = window.indexedDB.open("StoryDB", 3);

  request.onerror = function(event) {
    console.error("Lỗi khi mở IndexedDB:", event.target.error);
  };

  request.onsuccess = function(event) {
    idb = event.target.result;
    console.log("IndexedDB đã sẵn sàng.");
  };

  request.onupgradeneeded = function(event) {
    idb = event.target.result;
    if (!idb.objectStoreNames.contains("stories")) {
      idb.createObjectStore("stories", { keyPath: "url" });
    }
    if (!idb.objectStoreNames.contains("downloaded_stories")) {
      idb.createObjectStore("downloaded_stories", { keyPath: "url" });
    }
  };
}


export async function fetchStory() {
	let inputField = document.getElementById("storyLink");
	let url = inputField.value.trim();
	inputField.value = url;

	if (!url) {
		alert("Vui lòng nhập link truyện!");
		return;
	}

	const proxyUrl = "https://api.allorigins.win/raw?url=";
	let fetchUrl = proxyUrl + encodeURIComponent(url);

	try {
		let response = await fetch(fetchUrl);
		let text = await response.text();
		let parser = new DOMParser();
		let doc = parser.parseFromString(text, "text/html");

		let titleMatch = doc.querySelector("h1")?.innerText.match(/\[(.*?)\]\s*(\[.*?\])?(.*)/);
		let title = titleMatch ? titleMatch[3].trim() : "Không rõ";
		let fullTitle = doc.querySelector("h1")?.innerText.trim() || "Không rõ";

		let tagMatches = fullTitle.match(/\[(.*?)\]/g);
		let defaultTag = tagMatches ? tagMatches[tagMatches.length - 1].replace(/\[|\]/g, "") : "Không rõ";

		let status = doc.querySelector("h1.p-title-value span")?.textContent.trim() || "Không rõ";
		let author = "Không rõ";
		let editor = "Không rõ";

		doc.querySelectorAll("article.message-body.js-selectToQuote div").forEach(div => {
			let text = div.innerText.trim();
			let authorMatch = text.match(/Tác giả:\s*(.+)|Author:\s*(.+)/i);
			if (authorMatch) author = authorMatch[1] || authorMatch[2];

			let editorMatch = text.match(/Editor:\s*(.+)|Edit:\s*(.+)|Edit\s*\+\s*beta:\s*(.+)/i);
			if (editorMatch) editor = editorMatch[1] || editorMatch[2] || editorMatch[3];
		});

		editor = editor.replace(/^@/, "").trim();

		let story = {
			title,
			defaultTag,
			userTags: [],
			author,
			editor,
			status,
			url,
			review: {}
		};

		let existingStory = await fetchStoryFromFirestore(url);

		if (existingStory) {
			story.userTags = existingStory.userTags || {};
			story.review = existingStory.review || {};
		}

		displayStoryDetails(story);
		await saveStory(story);
	} catch (error) {
		console.error("Lỗi khi fetch truyện:", error);
		alert("Không thể lấy dữ liệu từ link này!");
	}
}

export function removeVietnameseTones(str) {
	return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
		.replace(/đ/g, "d").replace(/Đ/g, "D");
}

export async function saveStoryToFirestore(story) {
	try {
		let storyId = removeVietnameseTones(story.title)
			.replace(/[^\w\s]/gi, "")
			.replace(/\s+/g, "_")
			.trim();

		let storyRef = doc(storiesCollection, storyId);

		let existingDoc = await getDoc(storyRef);
		let existingData = existingDoc.exists() ? existingDoc.data() : {};

		let updatedStory = {
			...existingData,
			...story,
			userTags: {
				...(existingData.userTags || {}),
				...(story.userTags || {})
			}
		};

		await setDoc(storyRef, updatedStory, { merge: true });
	} catch (error) {
		console.error("Lỗi khi lưu vào Firestore:", error);
	}
}

export async function saveStoryToIndexedDB(story, storeName = "stories") {
	if (!idb) {
		console.warn("IndexedDB chưa sẵn sàng.");
		return;
	}

	if (!story.url) {
		console.error("Lỗi: Không thể lưu truyện vào IndexedDB vì thiếu 'url'!");
		return;
	}

	let transaction = idb.transaction([storeName], "readwrite");
	let store = transaction.objectStore(storeName);

	let getRequest = store.get(story.url);
	getRequest.onsuccess = function (event) {
		let existingStory = event.target.result || {};

		let updatedStory = {
			...existingStory,
			...story,
			userTags: {
				...(existingStory.userTags || {}),
				...(story.userTags || {})
			}
		};

		store.put(updatedStory);
	};

	getRequest.onerror = function (event) {
		console.error("Lỗi khi truy vấn IndexedDB:", event.target.error);
	};
}

export async function saveStory(story) {
	try {
		await saveStoryToFirestore(story);
		saveStoryToIndexedDB(story);
		await fetchTagsFromDatabase();
		loadStories();
	} catch (error) {
		console.error("Lỗi khi lưu truyện:", error);
	}
}

export async function fetchStoryFromFirestore(url) {
	let querySnapshot = await getDocs(query(collection(db, "stories"), where("url", "==", url)));
	if (!querySnapshot.empty) {
		return querySnapshot.docs[0].data();
	}
	return null;
}

export async function loadStories() {
	let indexedDBStories = await loadStoriesFromIndexedDB("stories");
	let storyMap = {};

	indexedDBStories.forEach(story => {
		storyMap[story.url] = story;
	});

	renderStories(indexedDBStories, "storyTable");

	try {
		let firestoreStories = await getDocs(storiesCollection);
		let stories = [];

		firestoreStories.forEach((doc) => {
			let story = doc.data();
			story.id = doc.id;

			if (storyMap[story.url]) {
				story.userTags = {
					...(storyMap[story.url].userTags || {}),
					...(story.userTags || {})
				};
			}

			stories.push(story);
			saveStoryToIndexedDB(story);
		});

		renderStories(stories, "storyTable");
	} catch (error) {
		console.error("Lỗi khi tải truyện từ Firestore:", error);
	}
}

export async function loadDownloadedStories() {
	let indexedDBStories = await loadStoriesFromIndexedDB("downloaded_stories");
	let storyMap = {};

	indexedDBStories.forEach(story => {
		storyMap[story.url] = story;
	});

	renderStories(indexedDBStories, "downloadedStoryTable");

	try {
		let firestoreStories = await getDocs(downloadedStoriesCollection);
		let stories = [];

		firestoreStories.forEach((doc) => {
			let story = doc.data();
			story.id = doc.id;

			if (storyMap[story.url]) {
				story.userTags = {
					...(storyMap[story.url].userTags || {}),
					...(story.userTags || {})
				};
			}

			stories.push(story);
			saveStoryToIndexedDB(story, "downloaded_stories");
		});

		renderStories(stories, "downloadedStoryTable");
	} catch (error) {
		console.error("Lỗi khi tải downloaded stories:", error);
	}
}

export async function loadStoriesFromIndexedDB(storeName) {
	return new Promise((resolve, reject) => {
		if (!idb) {
			resolve([]);
			return;
		}

		let transaction = idb.transaction([storeName], "readonly");
		let store = transaction.objectStore(storeName);
		let request = store.getAll();

		request.onsuccess = function (event) {
			resolve(event.target.result);
		};

		request.onerror = function (event) {
			console.error("Lỗi khi tải từ IndexedDB:", event.target.error);
			resolve([]);
		};
	});
}

export async function deleteStoryFromFirestore(storyId, collectionName = "stories") {
	await deleteDoc(doc(db, collectionName, storyId));
}

export async function deleteStoryFromIndexedDB(storyUrl, storeName = "stories") {
	let transaction = idb.transaction([storeName], "readwrite");
	let store = transaction.objectStore(storeName);
	store.delete(storyUrl);
}

export async function deleteStory(storyUrl, storyId, collectionName = "stories", tableId = "storyTable") {
	deleteStoryFromIndexedDB(storyUrl, collectionName === "stories" ? "stories" : "downloaded_stories");
	if (storyId) {
		deleteStoryFromFirestore(storyId, collectionName);
	}
	setTimeout(() => {
		if (collectionName === "stories") {
			loadStories();
		} else {
			loadDownloadedStories();
		}
	}, 500);
}

export async function fetchTagsFromDatabase() {
	try {
		let querySnapshot = await getDocs(collection(db, "stories"));
		allTags = new Set();

		querySnapshot.forEach(doc => {
			let storyData = doc.data();
			if (storyData.defaultTag) allTags.add(storyData.defaultTag);
			if (storyData.userTags && typeof storyData.userTags === "object") {
				Object.values(storyData.userTags).forEach(tag => allTags.add(tag));
			}
		});

		allTags = [...allTags];
	} catch (error) {
		console.error("Lỗi khi tải tag:", error);
	}
}

export async function loadAllTags() {
	let allTagsSet = new Set();
	let querySnapshot = await getDocs(collection(db, "stories"));

	querySnapshot.forEach(doc => {
		let story = doc.data();
		if (story.defaultTag) {
			allTagsSet.add(story.defaultTag);
		}
		if (story.userTags && typeof story.userTags === "object") {
			Object.values(story.userTags).forEach(userTagList => {
				userTagList.forEach(tag => allTagsSet.add(tag));
			});
		}
	});

	window.allTags = Array.from(allTagsSet);
}

export async function updateReview(storyUrl, reviewText, collectionName = "stories") {
	let querySnapshot = await getDocs(query(collection(db, collectionName), where("url", "==", storyUrl)));
	if (querySnapshot.empty) return;

	let storyDoc = querySnapshot.docs[0];
	let storyId = storyDoc.id;
	let username = localStorage.getItem("username") || "Guest";

	let storyRef = doc(db, collectionName, storyId);
	let storyData = storyDoc.data();

	let existingReviews = storyData.review || {};
	existingReviews[username] = [reviewText];

	await setDoc(storyRef, { review: existingReviews }, { merge: true });
}


window.fetchStory = fetchStory;
window.deleteStory = deleteStory;
window.saveStory = saveStory;
window.updateReview = updateReview;
window.loadDownloadedStories = loadDownloadedStories