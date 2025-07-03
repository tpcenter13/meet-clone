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
  Unsubscribe,
} from "firebase/firestore";
import { useSearchParams } from "react-router-dom";

// VideoPlayer Component
interface VideoPlayerProps {
  stream: MediaStream;
  muted: boolean;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ stream, muted }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream && stream.active) {
      console.log("Setting video stream for:", stream.id, "active:", stream.active);
      videoRef.current.srcObject = stream;
      videoRef.current.onloadedmetadata = () => {
        videoRef.current
          ?.play()
          .then(() => console.log("Video playback started for stream:", stream.id))
          .catch((err: Error) => console.error("Video play error for stream:", stream.id, err));
      };
    }
  }, [stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      className="w-full h-full bg-black rounded object-cover"
    />
  );
};

const VideoCall: React.FC = () => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [isSharingScreen, setIsSharingScreen] = useState<boolean>(false);
  const [roomId, setRoomId] = useState<string>("");
  const [participants, setParticipants] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<
    { id: string; text: string; senderId: string; senderName: string; timestamp: string; type?: string }[]
  >([]);
  const [newMessage, setNewMessage] = useState<string>("");
  const [selectedEmotion, setSelectedEmotion] = useState<string | null>(null);
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const dataChannels = useRef<Record<string, RTCDataChannel>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  const unsubscribeFunctions = useRef<(() => void)[]>([]);
  const isInitialized = useRef<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const clientId = useRef<string>(
    crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
  ).current;

  const emotions = ["Sad", "Happy", "Anxious", "Angry", "Fear", "Disgust"];

  const styleMap: Record<string, { bg: string; border: string; text: string }> = {
  Sad: { bg: "bg-blue-300", border: "border-blue-500", text: "text-blue-900" },
  Happy: { bg: "bg-yellow-300", border: "border-yellow-500", text: "text-yellow-900" },
  Anxious: { bg: "bg-purple-300", border: "border-purple-500", text: "text-purple-900" },
  Angry: { bg: "bg-red-400", border: "border-red-600", text: "text-red-900" },
  Fear: { bg: "bg-gray-400", border: "border-gray-600", text: "text-gray-900" },
  Disgust: { bg: "bg-green-300", border: "border-green-500", text: "text-green-900" },
};


  useEffect(() => {
    console.log("Initialized with clientId:", clientId);
  }, [clientId]);

  // Scroll to the bottom of the chat when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
      } catch (err: unknown) {
        console.error("Error accessing media devices:", err);
        try {
          const audioStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          console.log("Audio-only stream initialized:", audioStream.id);
          setLocalStream(audioStream);
          await joinRoom(id, audioStream);
          alert("Camera access failed. Proceeding with audio only.");
        } catch (audioErr: unknown) {
          console.error("Error accessing audio-only stream:", audioErr);
          alert("Unable to access camera or microphone. Please check permissions.");
        }
      }
    };
    initRoom();

    return () => {
      console.log("Cleaning up local stream, peer connections, and subscriptions");
      if (localStream) {
        localStream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      }
      Object.values(peerConnections.current).forEach((pc: RTCPeerConnection) => pc.close());
      Object.values(dataChannels.current).forEach((dc: RTCDataChannel) => dc.close());
      peerConnections.current = {};
      dataChannels.current = {};
      unsubscribeFunctions.current.forEach((unsubscribe: () => void) => unsubscribe());
      unsubscribeFunctions.current = [];
      leaveRoom();
    };
  }, [clientId, localStream, searchParams, setSearchParams]);

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

      await setupIncomingConnectionListener(roomId, stream);

      const unsubscribeParticipants: Unsubscribe = onSnapshot(participantsCollection, (snapshot) => {
        const currentParticipants = new Set<string>();
        const newParticipants: string[] = [];

        snapshot.forEach((doc) => {
          const data = doc.data();
          if (data?.id && data.id !== clientId) {
            currentParticipants.add(data.id);
            if (!participants.has(data.id)) {
              newParticipants.push(data.id);
            }
          }
        });

        console.log("Current participants:", Array.from(currentParticipants));
        console.log("New participants:", newParticipants);

        newParticipants.forEach(async (participantId: string) => {
          if (!peerConnections.current[participantId]) {
            const shouldInitiate = clientId < participantId;
            console.log("New participant detected:", participantId, "shouldInitiate:", shouldInitiate);
            await createPeerConnection(participantId, roomId, stream, shouldInitiate);
          }
        });

        participants.forEach((participantId: string) => {
          if (!currentParticipants.has(participantId)) {
            console.log("Participant left:", participantId);
            cleanupPeerConnection(participantId);
          }
        });

        setParticipants(currentParticipants);
      });
      unsubscribeFunctions.current.push(unsubscribeParticipants);
    } catch (err: unknown) {
      console.error("Error joining room:", err);
    }
  };

  const setupIncomingConnectionListener = async (roomId: string, stream: MediaStream) => {
    const offersCollection = collection(db, "rooms", roomId, "offers");
    const offerQuery = query(offersCollection, where("to", "==", clientId));

    const unsubscribeOffers: Unsubscribe = onSnapshot(offerQuery, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          const fromId: string = data.from;
          console.log("Received offer from:", fromId);

          if (fromId && fromId !== clientId) {
            if (!peerConnections.current[fromId]) {
              await createPeerConnection(fromId, roomId, stream, false);
            }
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

    // Create data channel for chat and emotions
    let dataChannel: RTCDataChannel | null = null;
    if (shouldInitiate) {
      dataChannel = pc.createDataChannel("chat");
      dataChannels.current[peerId] = dataChannel;
      dataChannel.onopen = () => console.log(`Data channel opened with ${peerId}`);
      dataChannel.onclose = () => console.log(`Data channel closed with ${peerId}`);
      dataChannel.onmessage = (event: MessageEvent) => {
        const message = JSON.parse(event.data);
        setMessages((prev) => [...prev, message]);
      };
    }

    // Handle incoming data channels
    pc.ondatachannel = (event: RTCDataChannelEvent) => {
      dataChannel = event.channel;
      dataChannels.current[peerId] = dataChannel;
      dataChannel.onmessage = (event: MessageEvent) => {
        const message = JSON.parse(event.data);
        setMessages((prev) => [...prev, message]);
      };
      dataChannel.onopen = () => console.log(`Data channel opened with ${peerId}`);
      dataChannel.onclose = () => console.log(`Data channel closed with ${peerId}`);
    };

    pc.ontrack = (event: RTCTrackEvent) => {
      console.log("Received track from peer:", peerId, "kind:", event.track.kind);
      if (event.streams && event.streams[0]) {
        const remoteStream = event.streams[0];
        console.log("Setting remote stream for peer:", peerId, "stream ID:", remoteStream.id);
        setRemoteStreams((prev) => {
          const newMap = new Map(prev);
          newMap.set(peerId, remoteStream);
          return newMap;
        });
      }
    };

    if (stream) {
      stream.getTracks().forEach((track: MediaStreamTrack) => {
        console.log("Adding local track to peer connection:", track.kind, "for peer:", peerId);
        pc.addTrack(track, stream);
      });
    }

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
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
        }).catch((err: Error) => console.error("Error sending ICE candidate:", err));
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
        console.log("Creating offer for peer:", peerId);
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
      } catch (err: unknown) {
        console.error("Error creating/sending offer:", err);
      }
    }
  };

  const handleIncomingOffer = async (docId: string, data: any, fromId: string, roomId: string) => {
    const pc = peerConnections.current[fromId];
    if (!pc) {
      console.error("No peer connection found for:", fromId);
      return;
    }

    try {
      console.log("Handling offer from:", fromId);
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
    } catch (err: unknown) {
      console.error("Error handling incoming offer:", err);
    }
  };

  const setupSignalingListeners = async (pc: RTCPeerConnection, peerId: string, roomId: string) => {
    const pendingCandidates: RTCIceCandidate[] = [];

    const answersCollection = collection(db, "rooms", roomId, "answers");
    const answerQuery = query(answersCollection, where("to", "==", clientId), where("from", "==", peerId));

    const unsubscribeAnswers: Unsubscribe = onSnapshot(answerQuery, (snapshot) => {
      snapshot.docChanges().forEach(async (change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          try {
            console.log("Received answer from:", peerId);
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            console.log("Set remote description from answer:", peerId);

            while (pendingCandidates.length > 0) {
              const candidate = pendingCandidates.shift();
              if (candidate) {
                await pc.addIceCandidate(candidate);
                console.log("Added queued ICE candidate from:", peerId);
              }
            }

            await deleteDoc(change.doc.ref);
          } catch (err: unknown) {
            console.error("Error processing answer:", err);
          }
        }
      });
    });
    unsubscribeFunctions.current.push(unsubscribeAnswers);

    const candidatesCollection = collection(db, "rooms", roomId, "candidates");
    const candidateQuery = query(candidatesCollection, where("to", "==", clientId), where("from", "==", peerId));

    const unsubscribeCandidates: Unsubscribe = onSnapshot(candidateQuery, (snapshot) => {
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
          } catch (err: unknown) {
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
    if (dataChannels.current[peerId]) {
      dataChannels.current[peerId].close();
      delete dataChannels.current[peerId];
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
      Object.values(peerConnections.current).forEach((pc: RTCPeerConnection) => {
        const videoSender = pc.getSenders().find((s: RTCRtpSender) => s.track?.kind === "video");
        const audioSender = pc.getSenders().find((s: RTCRtpSender) => s.track?.kind === "audio");
        if (videoSender && screenStream.getVideoTracks()[0]) {
          videoSender.replaceTrack(screenStream.getVideoTracks()[0]);
        }
        if (audioSender && screenStream.getAudioTracks()[0]) {
          audioSender.replaceTrack(screenStream.getAudioTracks()[0]);
        }
      });
      setLocalStream(screenStream);
      screenStream.getVideoTracks()[0].onended = stopScreenShare;
    } catch (err: unknown) {
      console.error("Error sharing screen:", err);
    }
  };

  const stopScreenShare = async () => {
    setIsSharingScreen(false);
    if (localStream) {
      localStream.getTracks().forEach((track: MediaStreamTrack) => track.stop());
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      console.log("Restored camera stream:", stream.id);
      setLocalStream(stream);
      Object.values(peerConnections.current).forEach((pc: RTCPeerConnection) => {
        const videoSender = pc.getSenders().find((s: RTCRtpSender) => s.track?.kind === "video");
        const audioSender = pc.getSenders().find((s: RTCRtpSender) => s.track?.kind === "audio");
        if (videoSender && stream.getVideoTracks()[0]) {
          videoSender.replaceTrack(stream.getVideoTracks()[0]);
        }
        if (audioSender && stream.getAudioTracks()[0]) {
          audioSender.replaceTrack(stream.getAudioTracks()[0]);
        }
      });
    } catch (err: unknown) {
      console.error("Error restoring camera stream:", err);
    }
  };

  

  const sendMessage = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!newMessage.trim()) return;

    const message = {
      id: crypto.randomUUID(),
      text: newMessage,
      senderId: clientId,
      senderName: `User_${clientId.substring(0, 8)}`,
      timestamp: new Date().toISOString(),
      type: "text",
    };

    // Add message to local state
    setMessages((prev) => [...prev, message]);

    // Send message to all connected peers
    Object.entries(dataChannels.current).forEach(([peerId, dataChannel]) => {
      if (dataChannel.readyState === "open") {
        try {
          dataChannel.send(JSON.stringify(message));
          console.log(`Sent message to ${peerId}:`, message.text);
        } catch (err: unknown) {
          console.error(`Error sending message to ${peerId}:`, err);
        }
      }
    });

    setNewMessage("");
  };

  const sendEmotion = (emotion: string) => {
    setSelectedEmotion(emotion);
    const message = {
      id: crypto.randomUUID(),
      text: emotion,
      senderId: clientId,
      senderName: `User_${clientId.substring(0, 8)}`,
      timestamp: new Date().toISOString(),
      type: "emotion",
    };

    // Add emotion to local state
    setMessages((prev) => [...prev, message]);

    // Send emotion to all connected peers
    Object.entries(dataChannels.current).forEach(([peerId, dataChannel]) => {
      if (dataChannel.readyState === "open") {
        try {
          dataChannel.send(JSON.stringify(message));
          console.log(`Sent emotion to ${peerId}:`, emotion);
        } catch (err: unknown) {
          console.error(`Error sending emotion to ${peerId}:`, err);
        }
      }
    });
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
      } catch (err: unknown) {
        console.error("Error leaving room:", err);
      }
    }
  };

  const remoteStreamArray = Array.from(remoteStreams.entries());

  return (
    <div className="min-h-screen bg-gray-900 flex">

      
{/* Emotions Panel */}
<div className="w-24 bg-gray-800 text-white flex flex-col border-r border-gray-700">
  <div className="p-4 border-b border-gray-700">
    <h2 className="text-lg font-semibold">Emotions</h2>
  </div>
  <div className="flex-1 p-2 flex flex-col space-y-2 overflow-y-auto">
    {emotions.map((emotion) => {
      const styles = styleMap[emotion];
      const isSelected = selectedEmotion === emotion;

      return (
        <button
          key={emotion}
          onClick={() => sendEmotion(emotion)}
          className={`px-3 py-2 rounded-full text-sm font-bold transition-transform transform hover:scale-105 border-4 shadow-md
            ${
              isSelected
                ? `${styles.bg} ${styles.border} ${styles.text}`
                : `${styles.bg} ${styles.border} ${styles.text} opacity-80 hover:opacity-100`
            }`}
        >
          {emotion}
        </button>
      );
    })}
  </div>
</div>




      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="bg-gray-800 text-white p-4 flex flex-col items-center">
          <h1 className="text-2xl font-bold mb-2">MeetClone</h1>
          <p className="text-sm text-gray-300 mb-3">Room ID: {roomId}</p>
          <button
            className="bg-blue-600 text-white px-4 py-2 rounded mb-3 hover:bg-blue-700 transition-colors"
            onClick={copyInviteLink}
          >
            Copy Invite Link
          </button>
          <div className="flex space-x-2">
            <button
              className="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700 transition-colors"
              onClick={startScreenShare}
              disabled={isSharingScreen}
            >
              Share Screen
            </button>
            <button
              className="bg-red-600 text-white px-3 py-1 rounded text-sm hover:bg-red-700 transition-colors"
              onClick={stopScreenShare}
              disabled={!isSharingScreen}
            >
              Stop Sharing
            </button>
           
            <button
              className="bg-gray-600 text-white px-3 py-1 rounded text-sm hover:bg-gray-700 transition-colors"
              onClick={leaveRoom}
            >
              Leave Room
            </button>
          </div>
        </div>

        {/* Video Container */}
        <div className="flex-1 relative bg-gray-900">
          {remoteStreamArray.length > 0 ? (
            <>
              <div className="w-full h-full p-4">
                <div
                  className={`w-full h-full gap-4 ${
                    remoteStreamArray.length === 1
                      ? "flex items-center justify-center"
                      : remoteStreamArray.length === 2
                      ? "grid grid-cols-2"
                      : remoteStreamArray.length === 3
                      ? "grid grid-cols-3"
                      : remoteStreamArray.length === 4
                      ? "grid grid-cols-2 grid-rows-2"
                      : remoteStreamArray.length <= 6
                      ? "grid grid-cols-3 grid-rows-2"
                      : remoteStreamArray.length <= 9
                      ? "grid grid-cols-3 grid-rows-3"
                      : "grid grid-cols-4 grid-rows-3"
                  }`}
                >
                  {remoteStreamArray.map(([peerId, stream]) => (
                    <div
                      key={peerId}
                      className="relative bg-gray-800 rounded-lg overflow-hidden shadow-lg border border-gray-600 min-h-0"
                    >
                      <VideoPlayer stream={stream} muted={false} />
                      <div className="absolute bottom-2 left-2 bg-black bg-opacity-70 text-white px-2 py-1 rounded text-xs">
                        Participant ({peerId.substring(0, 8)})
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {localStream && (
                <div
                  className="absolute bottom-6 right-6 w-48 h-32 bg-gray-800 rounded-lg overflow-hidden shadow-lg border-2 border-blue-500"
                  style={{ zIndex: 10 }}
                >
                  <VideoPlayer stream={localStream} muted={true} />
                  <div className="absolute bottom-1 left-1 bg-black bg-opacity-70 text-white px-2 py-1 rounded text-xs">
                    You {isSharingScreen ? "(Sharing)" : ""}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center text-gray-400">
                <div className="text-6xl mb-4">👥</div>
                <p className="text-xl">Waiting for participants to join...</p>
                <p className="text-sm mt-2">Share the invite link to get started</p>
                {localStream && (
                  <div className="mt-8 w-96 h-64 mx-auto bg-gray-800 rounded-lg overflow-hidden shadow-lg border-2 border-blue-500 relative">
                    <VideoPlayer stream={localStream} muted={true} />
                    <div className="absolute bottom-2 left-2 bg-black bg-opacity-70 text-white px-2 py-1 rounded text-xs">
                      You {isSharingScreen ? "(Sharing)" : ""}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Status Bar */}
        <div className="bg-gray-800 text-gray-300 p-2 text-xs">
          <div className="flex justify-center space-x-4">
            <span>Local: {localStream ? "Connected" : "Not connected"}</span>
            <span>Remote Streams: {remoteStreams.size}</span>
            <span>Connections: {Object.keys(peerConnections.current).length}</span>
            <span>Participants: {participants.size}</span>
          </div>
        </div>
      </div>

      {/* Chat Panel */}
      <div className="w-80 bg-gray-800 text-white flex flex-col border-l border-gray-700">
        <div className="p-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold">Chat</h2>
        </div>
        <div className="flex-1 p-4 overflow-y-auto max-h-[calc(100vh-180px)]">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`mb-3 ${message.senderId === clientId ? "text-right" : "text-left"}`}
            >
              <p className="text-xs text-gray-400">
                {message.senderName} • {new Date(message.timestamp).toLocaleTimeString()}
              </p>
              <div
                className={`inline-block p-2 rounded-lg ${
                  message.type === "emotion"
                    ? "bg-purple-600 text-white font-semibold"
                    : message.senderId === clientId
                    ? "bg-blue-600 text-white"
                    : "bg-gray-700 text-white"
                }`}
              >
                {message.type === "emotion" ? `Feeling: ${message.text}` : message.text}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
        <div className="p-4 border-t border-gray-700">
          <form onSubmit={sendMessage} className="flex space-x-2">
            <input
              type="text"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              onKeyPress={(e) => e.key === "Enter" && sendMessage(e as any)}
              placeholder="Type a message..."
              className="flex-1 bg-gray-700 text-white px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <button
              type="submit"
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition-colors"
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default VideoCall;