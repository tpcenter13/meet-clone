import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCHsPe-y9dI_ipUXhuDak6hdDpEigdzlZI",
  authDomain: "webrtc-c2386.firebaseapp.com",
  projectId: "webrtc-c2386",
  storageBucket: "webrtc-c2386.firebasestorage.app",
  messagingSenderId: "676061610225",
  appId: "1:676061610225:web:902fbcbf93b9abd97d2950",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);