// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

const firebaseConfig = {
	apiKey: "AIzaSyBtpLSSNBj9lHtzibLh5QSRAPg3iQ46Q3g",
	authDomain: "tcct-minigames.firebaseapp.com",
	projectId: "tcct-minigames",
	storageBucket: "tcct-minigames.firebasestorage.app",
	messagingSenderId: "604780847536",
	appId: "1:604780847536:web:f8015bde5ef469b04c7675",
	measurementId: "G-1GGDZR6VY5"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { db };
