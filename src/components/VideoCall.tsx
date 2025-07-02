import React, { useState, useEffect, useRef } from "react";
import { db } from "../firebase";
import {
  collection,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  addDoc,
} from "firebase/firestore";
import VideoPlayer from "./VideoPlayer";
import { useSearchParams } from "react-router-dom";

const VideoCall = () => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<MediaStream[]>([]);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [roomId, setRoomId] = useState<string>("");
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  const clientId = Math.random().toString(36).substring(2); // Unique client ID

  // Generate or use roomId from URL, prompt to create if not provided
  useEffect(() => {
    const initRoom = async () => {
      let id = searchParams.get("room");
      if (!id) {
        id = `meet-${Math.random().toString(36).substring(2, 9)}`;
        setSearchParams({ room: id });
      }
      setRoomId(id);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        setLocalStream(stream);
        await joinRoom(id);
      } catch (err) {
        console.error("Error accessing media devices:", err);
      }
    };
    initRoom();

    return () => {
      localStream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const joinRoom = async (id: string) => {
    const roomRef = doc(db, "rooms", id);
    const roomSnapshot = await getDoc(roomRef);

    if (!roomSnapshot.exists()) {
      await setDoc(roomRef, { participants: [] });
    }

    const participantsCollection = collection(db, "rooms", id, "participants");
    onSnapshot(participantsCollection, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          if (data?.id !== clientId) {
            await createPeerConnection(data?.id || "", roomRef);
          }
        }
      });
    });

    await setDoc(doc(participantsCollection, clientId), { id: clientId });
  };

  const createPeerConnection = async (peerId: string, roomRef: any) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    peerConnections.current[peerId] = pc;

    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      setRemoteStreams((prev) => [...prev.filter((s) => s.id !== stream.id), stream]);
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const candidatesCollection = collection(db, "rooms", roomId, "candidates");
        addDoc(candidatesCollection, {
          candidate: event.candidate,
          to: peerId,
          from: clientId,
        });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const offersCollection = collection(db, "rooms", roomId, "offers");
    await setDoc(doc(offersCollection, peerId), { offer, from: clientId });

    const answersCollection = collection(db, "rooms", roomId, "answers");
    onSnapshot(doc(answersCollection, clientId), (docSnap) => {
      const data = docSnap.data();
      if (data?.answer && !pc.remoteDescription) {
        pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      }
    });

    const candidatesCollection = collection(db, "rooms", roomId, "candidates");
    onSnapshot(candidatesCollection, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          if (data.to === clientId) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          }
        }
      });
    });
  };

  const startScreenShare = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      setIsSharingScreen(true);
      const screenTrack = screenStream.getVideoTracks()[0];
      Object.values(peerConnections.current).forEach((pc) => {
        const sender = pc.getSenders().find(
          (s) => s.track && s.track.kind === "video"
        );
        if (sender && screenTrack) {
          sender.replaceTrack(screenTrack);
        }
      });
      setLocalStream(screenStream);
      screenTrack.onended = stopScreenShare;
    } catch (err) {
      console.error("Error sharing screen:", err);
    }
  };

  const stopScreenShare = async () => {
    setIsSharingScreen(false);
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    setLocalStream(stream);
    Object.values(peerConnections.current).forEach((pc) => {
      const sender = pc.getSenders().find(
        (s) => s.track && s.track.kind === "video"
      );
      if (sender && stream.getVideoTracks()[0]) {
        sender.replaceTrack(stream.getVideoTracks()[0]);
      }
    });
  };

  const startRecording = async () => {
    if (!localStream) return;
    const recorder = new MediaRecorder(localStream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: "video/webm" });
      const recordingsCollection = collection(db, "recordings");
      await addDoc(recordingsCollection, {
        roomId,
        timestamp: new Date().toISOString(),
        url: "placeholder_url",
      });
    };
    recorder.start();
    setTimeout(() => recorder.stop(), 30000); // Stop after 30s for demo
  };

  const copyInviteLink = () => {
    const baseUrl = window.location.origin; // e.g., https://meet-clone-xyz.vercel.app
    const inviteLink = `${baseUrl}?room=${roomId}`;
    navigator.clipboard.writeText(inviteLink).then(() => {
      alert("Invite link copied to clipboard!");
    });
  };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center p-4">
      <h1 className="text-3xl font-bold mb-4">MeetClone</h1>
      <p className="mb-2">Room ID: {roomId}</p>
      <button
        className="bg-blue-500 text-white px-4 py-2 rounded mb-4 hover:bg-blue-600"
        onClick={copyInviteLink}
      >
        Copy Invite Link
      </button>
      <div className="flex space-x-4 mb-4">
        <button
          className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600"
          onClick={startScreenShare}
          disabled={isSharingScreen}
        >
          Share Screen
        </button>
        <button
          className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600"
          onClick={stopScreenShare}
          disabled={!isSharingScreen}
        >
          Stop Sharing
        </button>
        <button
          className="bg-green-500 text-white px-4 py-2 rounded hover:bg-green-600"
          onClick={startRecording}
        >
          Record
        </button>
      </div>
      <div className="grid grid-cols-2 gap-4">
        {localStream && <VideoPlayer stream={localStream} muted={true} />}
        {remoteStreams.map((stream) => (
          <VideoPlayer key={stream.id} stream={stream} muted={false} />
        ))}
      </div>
    </div>
  );
};

export default VideoCall;