// main.js - giao diện chính
import * as storage from './storage.js';
import { autoFillLofterLinks } from './crawler.js';

import { db } from './firebase.js';
import { collection, getDocs, query, where, doc, getDoc, setDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

const dbName = "StoryDB";
let idb;

export async function toggleSection(section) {
	document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
	document.getElementById(section).classList.add('active');
	document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
	document.getElementById('btn-' + section).classList.add('active');
	
	document.querySelectorAll('.table-section').forEach(t => t.classList.add('hidden'));
	if (section === 'epub') {
		document.getElementById('downloaded-stories').classList.remove('hidden');
		loadDownloadedStories();
	} else {
		document.getElementById('saved-stories').classList.remove('hidden');
	}
}

export async function logMessage(msg) {
	const logBox = document.getElementById('log');
	logBox.value += msg + '\n';
	logBox.scrollTop = logBox.scrollHeight;
}


export async function populateSelectOptions() {
	let authors = new Set();
	let editors = new Set();
	let querySnapshot = await getDocs(collection(db, "stories"));

	querySnapshot.forEach(doc => {
		let story = doc.data();
		if (story.author) authors.add(story.author);
		if (story.editor) editors.add(story.editor);
	});

	let authorSelect = document.getElementById("authorSelect");
	let editorSelect = document.getElementById("editorSelect");

	authorSelect.innerHTML = '<option value="">Tất cả</option>';
	editorSelect.innerHTML = '<option value="">Tất cả</option>';

	authors.forEach(author => {
		authorSelect.innerHTML += `<option value="${author}">${author}</option>`;
	});
	editors.forEach(editor => {
		editorSelect.innerHTML += `<option value="${editor}">${editor}</option>`;
	});
}

export async function sortTable(columnIndex, tableType) {
	let tableId = tableType === 'saved' ? "storyTable" : "downloadedStoryTable";
	let table = document.getElementById(tableId);
	let rows = Array.from(table.rows);
	let isAscending = table.dataset.sortOrder !== "asc";
	table.dataset.sortOrder = isAscending ? "asc" : "desc";

	rows.sort((a, b) => {
		let aValue = a.cells[columnIndex].innerText;
		let bValue = b.cells[columnIndex].innerText;

		if (columnIndex === 0) {
			aValue = parseInt(aValue) || 0;
			bValue = parseInt(bValue) || 0;
		}

		if (aValue < bValue) return isAscending ? -1 : 1;
		if (aValue > bValue) return isAscending ? 1 : -1;
		return 0;
	});

	table.innerHTML = "";
	rows.forEach(row => table.appendChild(row));
}

export async function displayStoryDetails(story) {
	let allTags = [story.defaultTag];

	if (story.userTags && typeof story.userTags === "object") {
		Object.values(story.userTags).forEach(tagList => {
			tagList.forEach(tag => allTags.push(tag));
		});
	}

	document.getElementById("additionalTags").value = allTags.join(", ");

	let allReviews = [];
	if (story.review && typeof story.review === "object") {
		Object.entries(story.review).forEach(([username, reviews]) => {
			allReviews.push(`${username}: ${reviews.join(", ")}`);
		});
	}

	document.getElementById("reviewText").value = allReviews.join(" | ");
}

export async function renderStories(stories, tableId) {
	let storyTable = document.getElementById(tableId);
	storyTable.innerHTML = "";

	stories.forEach((story, index) => {
		let allTags = story.defaultTag || "Không có tag";

		if (story.userTags && typeof story.userTags === "object") {
			let userTagList = Object.entries(story.userTags)
				.map(([_, tag]) => tag)
				.join(", ");

			if (userTagList) {
				allTags += `, ${userTagList}`;
			}
		}

		let collectionName = tableId === "storyTable" ? "stories" : "downloaded_stories";
		let row = `
			<tr>
				<td>${index + 1}</td>
				<td>${story.title}</td>
				<td>${allTags}</td>
				<td>${story.author}</td>
				<td>${story.editor}</td>
				<td>${story.status}</td>
				<td><a href="${story.url}" target="_blank">Xem</a></td>
				<td contenteditable="true" onblur="updateReview('${story.url}', this.innerText, '${collectionName}')">
					${story.review ? Object.values(story.review || {}).join(", ") : ""}
				</td>
				<td class="delete-btn" onclick="deleteStory('${story.url}', '${story.id || ""}', '${collectionName}', '${tableId}')">🗑</td>
			</tr>
		`;
		storyTable.innerHTML += row;
	});
}

export async function suggestTags(event) {
	let input = event.target;
	let inputValue = input.value.trim().toLowerCase();
	let suggestionsBox = document.getElementById("tagSuggestions");

	if (!inputValue) {
		suggestionsBox.style.display = "none";
		return;
	}

	let filteredTags = window.allTags.filter(tag => {
		let words = tag.toLowerCase().split(" ");
		return words.some(word => word.startsWith(inputValue));
	});

	if (filteredTags.length === 0) {
		suggestionsBox.style.display = "none";
		return;
	}

	suggestionsBox.innerHTML = "";
	filteredTags.forEach(tag => {
		let suggestion = document.createElement("div");
		suggestion.textContent = tag;
		suggestion.classList.add("suggestion-item");
		suggestion.onclick = () => selectTag(tag);
		suggestionsBox.appendChild(suggestion);
	});

	suggestionsBox.style.display = "block";
}

export async function selectTag(tag) {
	let inputField = document.getElementById("additionalTags");
	let existingTags = inputField.value.split(",").map(t => t.trim());

	if (!existingTags.includes(tag)) {
		existingTags.push(tag);
	}

	inputField.value = existingTags.join(", ");
	document.getElementById("tagSuggestions").style.display = "none";
}

export async function filterStories() {
	let desiredTags = document.getElementById("desiredTags").value.split(",").map(t => t.trim()).filter(t => t);
	let excludedTags = document.getElementById("excludedTags").value.split(",").map(t => t.trim()).filter(t => t);
	let author = document.getElementById("authorSelect").value;
	let editor = document.getElementById("editorSelect").value;
	let status = document.getElementById("statusSelect").value;

	let q = query(collection(db, "stories"));
	let stories = [];

	let querySnapshot = await getDocs(q);
	querySnapshot.forEach(doc => {
		let story = doc.data();
		story.id = doc.id;

		let tags = [story.defaultTag, ...(story.userTags ? Object.values(story.userTags).flat() : [])];
		let include = true;

		if (desiredTags.length > 0 && !desiredTags.every(tag => tags.includes(tag))) {
			include = false;
		}
		if (excludedTags.length > 0 && excludedTags.some(tag => tags.includes(tag))) {
			include = false;
		}
		if (author && story.author !== author) {
			include = false;
		}
		if (editor && story.editor !== editor) {
			include = false;
		}
		if (status && story.status !== status) {
			include = false;
		}

		if (include) {
			stories.push(story);
		}
	});

	renderStories(stories, "storyTable");
}

export async function randomStory() {
	let querySnapshot = await getDocs(collection(db, "stories"));
	let stories = [];

	querySnapshot.forEach(doc => {
		let story = doc.data();
		story.id = doc.id;
		stories.push(story);
	});

	if (stories.length > 0) {
		let randomIndex = Math.floor(Math.random() * stories.length);
		renderStories([stories[randomIndex]], "storyTable");
	}
}


document.getElementById("additionalTags").addEventListener("input", async function(event) {
	let input = event.target;
	let value = input.value.trim();

	if (value.endsWith(",")) {
		let tag = value.slice(0, -1).trim();

		if (!tag) return;

		let storyURL = document.getElementById("storyLink").value.trim();
		if (!storyURL) {
			alert("Bạn cần nhập link truyện trước khi thêm tag.");
			return;
		}

		let querySnapshot = await getDocs(query(collection(db, "stories"), where("url", "==", storyURL)));

		if (querySnapshot.empty) {
			alert("Truyện này chưa được lưu, không thể thêm tag.");
			return;
		}

		let storyDoc = querySnapshot.docs[0];
		let storyId = storyDoc.id;

		let username = localStorage.getItem("username") || "Guest";
		let storyRef = doc(db, "stories", storyId);
		let storyData = storyDoc.data();
		if (!storyData) return;

		let existingTags = storyData.userTags || {};
		existingTags[username] = existingTags[username] ? [...existingTags[username], tag] : [tag];

		await setDoc(storyRef, { userTags: existingTags }, { merge: true });
	}
});

document.getElementById("reviewText").addEventListener("input", async function(event) {
	let input = event.target;
	let value = input.value.trim();

	if (value.endsWith(".")) {
		let review = value.slice(0, -1).trim();

		if (!review) return;

		let storyURL = document.getElementById("storyLink").value.trim();
		if (!storyURL) {
			alert("Bạn cần nhập link truyện trước khi thêm review.");
			return;
		}

		let querySnapshot = await getDocs(query(collection(db, "stories"), where("url", "==", storyURL)));

		if (querySnapshot.empty) {
			alert("Truyện này chưa được lưu, không thể thêm review.");
			return;
		}

		let storyDoc = querySnapshot.docs[0];
		let storyId = storyDoc.id;

		let username = localStorage.getItem("username") || "Guest";
		let storyRef = doc(db, "stories", storyId);
		let storyData = storyDoc.data();
		if (!storyData) return;

		let existingReviews = storyData.review || {};
		existingReviews[username] = existingReviews[username] ? [...existingReviews[username], review] : [review];

		await setDoc(storyRef, { review: existingReviews }, { merge: true });
	}
});

document.getElementById("additionalTags").addEventListener("input", suggestTags);

document.addEventListener("click", function(event) {
	if (!event.target.closest("#additionalTags") && !event.target.closest("#tagSuggestions")) {
		document.getElementById("tagSuggestions").style.display = "none";
	}
});

document.addEventListener("DOMContentLoaded", async () => {
  await storage.loadStories();
  await storage.loadAllTags();
  await populateSelectOptions();
});

document.addEventListener("DOMContentLoaded", async () => {
  await storage.loadStories();
  await storage.loadAllTags();
  await populateSelectOptions();

  document.getElementById("saveStory").addEventListener("click", async () => {
    await fetchStory();
  });
});

window.toggleSection = toggleSection;
window.renderStories = renderStories;
window.suggestTags = suggestTags;
window.filterStories = filterStories;
window.randomStory = randomStory;