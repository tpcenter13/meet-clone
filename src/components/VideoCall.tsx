import React, { useState, useEffect, useRef } from "react";
import { db } from "../firebase";
import {
  collection,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  addDoc,
  deleteDoc,
  query,
  where,
} from "firebase/firestore";
import { useSearchParams } from "react-router-dom";

// VideoPlayer Component
const VideoPlayer = ({ stream, muted }: { stream: MediaStream; muted: boolean }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream && stream.active) {
      console.log("Setting video stream for:", stream.id, "active:", stream.active);
      videoRef.current.srcObject = stream;
      // Ensure video element is loaded before playing
      videoRef.current.onloadedmetadata = () => {
        videoRef.current
          ?.play()
          .then(() => console.log("Video playback started for stream:", stream.id))
          .catch((err) => console.error("Video play error for stream:", stream.id, err));
      };
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
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const [roomId, setRoomId] = useState<string>("");
  const [participants, setParticipants] = useState<Set<string>>(new Set());
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  const unsubscribeFunctions = useRef<(() => void)[]>([]);
  const isInitialized = useRef(false);

  // Generate a unique clientId
  const clientId = useRef(crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`)
    .current;

  useEffect(() => {
    console.log("Initialized with clientId:", clientId);
  }, [clientId]);

  // Initialize room and media
  useEffect(() => {
    if (isInitialized.current) return;
    isInitialized.current = true;

    const initRoom = async () => {
      let id = searchParams.get("room");
      if (!id) {
        id = `meet-${Math.random().toString(36).substring(2, 9)}`;
        setSearchParams({ room: id });
      }
      console.log("Setting roomId:", id);
      setRoomId(id);

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        console.log("Local stream initialized:", stream.id, "Client ID:", clientId);
        setLocalStream(stream);
        await joinRoom(id, stream);
      } catch (err) {
        console.error("Error accessing media devices:", err);
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          console.log("Audio-only stream initialized:", audioStream.id);
          setLocalStream(audioStream);
          await joinRoom(id, audioStream);
          alert("Camera access failed. Proceeding with audio only.");
        } catch (audioErr) {
          console.error("Error accessing audio-only stream:", audioErr);
          alert("Unable to access camera or microphone. Please check permissions.");
        }
      }
    };
    initRoom();

    return () => {
      console.log("Cleaning up local stream and peer connections");
      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
      }
      Object.values(peerConnections.current).forEach((pc) => pc.close());
      peerConnections.current = {};
      unsubscribeFunctions.current.forEach((unsubscribe) => unsubscribe());
      unsubscribeFunctions.current = [];
      leaveRoom();
    };
  }, []);

  const joinRoom = async (roomId: string, stream: MediaStream) => {
    if (!roomId) {
      console.error("No roomId provided");
      return;
    }

    const roomRef = doc(db, "rooms", roomId);
    try {
      const roomSnapshot = await getDoc(roomRef);
      if (!roomSnapshot.exists()) {
        console.log("Creating new room:", roomId);
        await setDoc(roomRef, { createdAt: new Date().toISOString() });
      }

      const participantsCollection = collection(db, "rooms", roomId, "participants");
      await setDoc(doc(participantsCollection, clientId), {
        id: clientId,
        joinedAt: new Date().toISOString(),
      });

      const unsubscribeParticipants = onSnapshot(participantsCollection, (snapshot) => {
        const currentParticipants = new Set<string>();

        snapshot.docs.forEach((doc) => {
          const data = doc.data();
          if (data?.id && data.id !== clientId) {
            currentParticipants.add(data.id);
          }
        });

        console.log("Current participants:", Array.from(currentParticipants));

        currentParticipants.forEach(async (participantId) => {
          if (!participants.has(participantId) && !peerConnections.current[participantId]) {
            console.log("New participant detected:", participantId);
            await createPeerConnection(participantId, roomId, stream, true);
          }
        });

        participants.forEach((participantId) => {
          if (!currentParticipants.has(participantId)) {
            console.log("Participant left:", participantId);
            cleanupPeerConnection(participantId);
          }
        });

        setParticipants(currentParticipants);
      });
      unsubscribeFunctions.current.push(unsubscribeParticipants);

      await setupIncomingConnectionListener(roomId, stream);
    } catch (err) {
      console.error("Error joining room:", err);
    }
  };

  const setupIncomingConnectionListener = async (roomId: string, stream: MediaStream) => {
    const offersCollection = collection(db, "rooms", roomId, "offers");
    const offerQuery = query(offersCollection, where("to", "==", clientId));

    const unsubscribeOffers = onSnapshot(offerQuery, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          const fromId = data.from;
          if (fromId && fromId !== clientId && !peerConnections.current[fromId]) {
            console.log("Received offer from:", fromId);
            await createPeerConnection(fromId, roomId, stream, false);
            await handleIncomingOffer(change.doc.id, data, fromId, roomId);
          }
        }
      });
    });
    unsubscribeFunctions.current.push(unsubscribeOffers);
  };

  const createPeerConnection = async (
    peerId: string,
    roomId: string,
    stream: MediaStream,
    shouldInitiate: boolean
  ) => {
    console.log("Creating peer connection for:", peerId, "shouldInitiate:", shouldInitiate);

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        {
          urls: "turn:openrelay.metered.ca:80",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
        {
          urls: "turn:openrelay.metered.ca:443",
          username: "openrelayproject",
          credential: "openrelayproject",
        },
      ],
    });

    peerConnections.current[peerId] = pc;

    pc.ontrack = (event) => {
      console.log("Received track from peer:", peerId, "kind:", event.track.kind);
      if (event.streams && event.streams[0]) {
        const remoteStream = event.streams[0];
        console.log("Setting remote stream for peer:", peerId);
        setRemoteStreams((prev) => new Map(prev).set(peerId, remoteStream));
      }
    };

    if (stream) {
      stream.getTracks().forEach((track) => {
        console.log("Adding local track to peer connection:", track.kind, "for peer:", peerId);
        pc.addTrack(track, stream);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("Sending ICE candidate to:", peerId);
        const candidatesCollection = collection(db, "rooms", roomId, "candidates");
        addDoc(candidatesCollection, {
          candidate: {
            candidate: event.candidate.candidate,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            sdpMid: event.candidate.sdpMid,
            usernameFragment: event.candidate.usernameFragment,
          },
          to: peerId,
          from: clientId,
        }).catch((err) => console.error("Error sending ICE candidate:", err));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("Connection state for", peerId, ":", pc.connectionState);
      if (pc.connectionState === "connected") {
        console.log("Successfully connected to peer:", peerId);
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        console.log("Connection failed/disconnected for peer:", peerId);
        cleanupPeerConnection(peerId);
      }
    };

    await setupSignalingListeners(pc, peerId, roomId);

    if (shouldInitiate) {
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await pc.setLocalDescription(offer);
        const offersCollection = collection(db, "rooms", roomId, "offers");
        await addDoc(offersCollection, {
          offer: offer,
          from: clientId,
          to: peerId,
          timestamp: new Date().toISOString(),
        });
        console.log("Sent offer to:", peerId);
      } catch (err) {
        console.error("Error creating/sending offer:", err);
      }
    }
  };

  const handleIncomingOffer = async (docId: string, data: any, fromId: string, roomId: string) => {
    const pc = peerConnections.current[fromId];
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const answersCollection = collection(db, "rooms", roomId, "answers");
      await addDoc(answersCollection, {
        answer: answer,
        from: clientId,
        to: fromId,
        timestamp: new Date().toISOString(),
      });
      console.log("Sent answer to:", fromId);
      await deleteDoc(doc(db, "rooms", roomId, "offers", docId));
    } catch (err) {
      console.error("Error handling incoming offer:", err);
    }
  };

  const setupSignalingListeners = async (pc: RTCPeerConnection, peerId: string, roomId: string) => {
    const pendingCandidates: RTCIceCandidate[] = [];

    const answersCollection = collection(db, "rooms", roomId, "answers");
    const answerQuery = query(answersCollection, where("to", "==", clientId), where("from", "==", peerId));

    const unsubscribeAnswers = onSnapshot(answerQuery, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          try {
            if (!pc.remoteDescription) {
              await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
              console.log("Set remote description from answer:", peerId);
              while (pendingCandidates.length > 0) {
                const candidate = pendingCandidates.shift();
                if (candidate) {
                  await pc.addIceCandidate(candidate);
                  console.log("Added queued ICE candidate from:", peerId);
                }
              }
            }
            await deleteDoc(change.doc.ref);
          } catch (err) {
            console.error("Error processing answer:", err);
          }
        }
      });
    });
    unsubscribeFunctions.current.push(unsubscribeAnswers);

    const candidatesCollection = collection(db, "rooms", roomId, "candidates");
    const candidateQuery = query(candidatesCollection, where("to", "==", clientId), where("from", "==", peerId));

    const unsubscribeCandidates = onSnapshot(candidateQuery, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          try {
            const candidate = new RTCIceCandidate({
              candidate: data.candidate.candidate,
              sdpMLineIndex: data.candidate.sdpMLineIndex,
              sdpMid: data.candidate.sdpMid,
              usernameFragment: data.candidate.usernameFragment,
            });
            if (pc.remoteDescription) {
              await pc.addIceCandidate(candidate);
              console.log("Added ICE candidate from:", peerId);
            } else {
              console.log("Queuing ICE candidate for:", peerId);
              pendingCandidates.push(candidate);
            }
            await deleteDoc(change.doc.ref);
          } catch (err) {
            console.error("Error adding ICE candidate:", err);
          }
        }
      });
    });
    unsubscribeFunctions.current.push(unsubscribeCandidates);
  };

  const cleanupPeerConnection = (peerId: string) => {
    if (peerConnections.current[peerId]) {
      peerConnections.current[peerId].close();
      delete peerConnections.current[peerId];
    }
    setRemoteStreams((prev) => {
      const newMap = new Map(prev);
      newMap.delete(peerId);
      return newMap;
    });
  };

  const startScreenShare = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      setIsSharingScreen(true);
      Object.values(peerConnections.current).forEach((pc) => {
        const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
        const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (videoSender && screenStream.getVideoTracks()[0]) {
          videoSender.replaceTrack(screenStream.getVideoTracks()[0]);
        }
        if (audioSender && screenStream.getAudioTracks()[0]) {
          audioSender.replaceTrack(screenStream.getAudioTracks()[0]);
        }
      });
      setLocalStream(screenStream);
      screenStream.getVideoTracks()[0].onended = stopScreenShare;
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
      console.log("Restored camera stream:", stream.id);
      setLocalStream(stream);
      Object.values(peerConnections.current).forEach((pc) => {
        const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
        const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (videoSender && stream.getVideoTracks()[0]) {
          videoSender.replaceTrack(stream.getVideoTracks()[0]);
        }
        if (audioSender && stream.getAudioTracks()[0]) {
          audioSender.replaceTrack(stream.getAudioTracks()[0]);
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
    setTimeout(() => recorder.stop(), 30000);
  };

  const copyInviteLink = () => {
    const baseUrl = window.location.origin + window.location.pathname;
    const inviteLink = `${baseUrl}?room=${roomId}`;
    navigator.clipboard.writeText(inviteLink).then(() => {
      alert("Invite link copied to clipboard!");
    });
  };

  const leaveRoom = async () => {
    if (clientId && roomId) {
      try {
        await deleteDoc(doc(db, "rooms", roomId, "participants", clientId));
      } catch (err) {
        console.error("Error leaving room:", err);
      }
    }
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
        <button
          className="bg-gray-500 text-white px-4 py-2 rounded hover:bg-gray-600"
          onClick={leaveRoom}
        >
          Leave Room
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
        {Array.from(remoteStreams.entries()).map(([peerId, stream]) => (
          <div key={peerId} className="relative">
            <VideoPlayer stream={stream} muted={false} />
            <p className="absolute bottom-2 left-2 text-white bg-black bg-opacity-50 px-2 py-1 rounded">
              Participant ({peerId.substring(0, 8)})
            </p>
          </div>
        ))}
      </div>
      <div className="mt-4 text-sm text-gray-600">
        <p>Local Stream: {localStream ? "Connected" : "Not connected"}</p>
        <p>Remote Streams: {remoteStreams.size}</p>
        <p>Peer Connections: {Object.keys(peerConnections.current).length}</p>
        <p>Participants: {participants.size}</p>
      </div>
    </div>
  );
};

export default VideoCall;