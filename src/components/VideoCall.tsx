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
import { useSearchParams } from "react-router-dom";

// VideoPlayer Component
const VideoPlayer = ({ stream, muted }: { stream: MediaStream; muted: boolean }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      console.log("Setting video stream for:", stream.id);
      videoRef.current.srcObject = stream;
      videoRef.current
        .play()
        .catch((err) => console.error("Video play error:", err));
    }
  }, [stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      className="w-full h-64 bg-black rounded"
    />
  );
};

const VideoCall = () => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<MediaStream[]>([]);
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [roomId, setRoomId] = useState<string>("");
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const [searchParams, setSearchParams] = useSearchParams();

  // Generate a unique clientId
  const clientId = useRef(
    crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
  ).current;

  useEffect(() => {
    console.log("Initialized with clientId:", clientId);
  }, [clientId]);

  // Initialize room and media
  useEffect(() => {
    const initRoom = async () => {
      let id = searchParams.get("room");
      if (!id) {
        id = `meet-${Math.random().toString(36).substring(2, 9)}`;
        setSearchParams({ room: id });
      }
      console.log("Setting roomId:", id); // Debug log
      setRoomId(id); // Set roomId immediately
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        console.log("Local stream initialized:", stream.id, "Client ID:", clientId);
        setLocalStream(stream);
        await joinRoom(id); // Pass roomId explicitly
      } catch (err) {
        console.error("Error accessing media devices:", err);
      }
    };
    initRoom();

    return () => {
      console.log("Cleaning up local stream");
      localStream?.getTracks().forEach((track) => track.stop());
      Object.values(peerConnections.current).forEach((pc) => pc.close());
    };
  }, []);

  const joinRoom = async (roomId: string) => {
    const roomRef = doc(db, "rooms", roomId);
    const roomSnapshot = await getDoc(roomRef);

    if (!roomSnapshot.exists()) {
      console.log("Creating new room:", roomId);
      await setDoc(roomRef, { participants: [] });
    }

    const participantsCollection = collection(db, "rooms", roomId, "participants");
    onSnapshot(participantsCollection, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          if (data?.id !== clientId && !peerConnections.current[data?.id || ""]) {
            console.log("Participant change detected:", data);
            await createPeerConnection(data?.id || "", roomRef, roomId); // Pass roomId explicitly
          }
        }
      });
    }, (error) => {
      console.error("Snapshot error:", error);
    });

    console.log("Adding client to participants:", clientId);
    await setDoc(doc(participantsCollection, clientId), { id: clientId });
  };

  const createPeerConnection = async (peerId: string, roomRef: any, roomId: string) => {
    console.log("Initializing peer connection for:", peerId, "with roomId:", roomId);
    if (!roomId || typeof roomId !== "string") {
      console.error("Invalid roomId detected:", roomId);
      return;
    }
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    peerConnections.current[peerId] = pc;

    if (localStream) {
      localStream.getTracks().forEach((track) => {
        console.log("Adding track to peer connection:", track.kind);
        pc.addTrack(track, localStream);
      });
    }

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      console.log("ontrack event fired for stream:", stream.id, "tracks:", event.track);
      setRemoteStreams((prev) => {
        const exists = prev.some((s) => s.id === stream.id);
        if (!exists) {
          console.log("Adding new remote stream:", stream.id);
          return [...prev, stream];
        }
        return prev;
      });
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("Sending ICE candidate to:", peerId, "candidate:", event.candidate);
        const candidatesCollection = collection(db, "rooms", roomId, "candidates");
        addDoc(candidatesCollection, {
          candidate: event.candidate,
          to: peerId,
          from: clientId,
        }).catch((err) => console.error("Error sending ICE candidate:", err));
      } else {
        console.log("All ICE candidates gathered for:", peerId);
      }
    };

    // Listen for incoming offers
    const offersCollection = collection(db, "rooms", roomId, "offers");
    onSnapshot(doc(offersCollection, clientId), async (docSnap) => {
      const data = docSnap.data();
      if (data?.offer && !pc.remoteDescription) {
        console.log("Received offer from:", data.from);
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const answersCollection = collection(db, "rooms", roomId, "answers");
        await setDoc(doc(answersCollection, data.from), { answer, from: clientId });
        console.log("Sent answer to:", data.from);
      }
    });

    // Create and send offer
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log("Created and sent offer for:", peerId, "in room:", roomId);
      const offersCollection = collection(db, "rooms", roomId, "offers"); // Re-declare to ensure correct roomId
      await setDoc(doc(offersCollection, peerId), { offer, from: clientId }).catch((err) =>
        console.error("Error setting offer document:", err, "roomId:", roomId)
      );
    } catch (err) {
      console.error("Error creating/sending offer:", err, "roomId:", roomId);
    }

    // Listen for answers
    const answersCollection = collection(db, "rooms", roomId, "answers");
    onSnapshot(doc(answersCollection, clientId), (docSnap) => {
      const data = docSnap.data();
      if (data?.answer && !pc.remoteDescription) {
        console.log("Received answer from:", data.from);
        pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(
          (err) => console.error("Error setting remote description:", err)
        );
      }
    });

    // Listen for ICE candidates
    const candidatesCollection = collection(db, "rooms", roomId, "candidates");
    onSnapshot(candidatesCollection, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          if (data.to === clientId) {
            console.log("Received ICE candidate from:", data.from);
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate)).catch(
              (err) => console.error("Error adding ICE candidate:", err)
            );
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
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
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
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      setLocalStream(stream);
      Object.values(peerConnections.current).forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
        if (sender && stream.getVideoTracks()[0]) {
          sender.replaceTrack(stream.getVideoTracks()[0]);
        }
      });
    } catch (err) {
      console.error("Error restoring camera stream:", err);
    }
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
    const baseUrl = window.location.origin;
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
      <div className="grid grid-cols-2 gap-4 max-w-4xl">
        {localStream && (
          <div className="relative">
            <VideoPlayer stream={localStream} muted={true} />
            <p className="absolute bottom-2 left-2 text-white bg-black bg-opacity-50 px-2 py-1 rounded">
              You
            </p>
          </div>
        )}
        {remoteStreams.map((stream) => (
          <div key={stream.id} className="relative">
            <VideoPlayer stream={stream} muted={false} />
            <p className="absolute bottom-2 left-2 text-white bg-black bg-opacity-50 px-2 py-1 rounded">
              Participant
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default VideoCall;