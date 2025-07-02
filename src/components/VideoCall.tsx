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
} from "firebase/firestore";
import { useSearchParams } from "react-router-dom";

// VideoPlayer Component
const VideoPlayer = ({ stream, muted }: { stream: MediaStream; muted: boolean }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      console.log("Setting video stream for:", stream.id, "active:", stream.active);
      videoRef.current.srcObject = stream;
      videoRef.current
        .play()
        .then(() => console.log("Video playback started for stream:", stream.id))
        .catch((err) => console.error("Video play error for stream:", stream.id, err));
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
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const [searchParams, setSearchParams] = useSearchParams();
  const unsubscribeFunctions = useRef<(() => void)[]>([]);

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
      console.log("Setting roomId:", id);
      setRoomId(id);

      try {
        // Mobile-friendly getUserMedia constraints
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: true,
        });
        console.log("Local stream initialized:", stream.id, "Client ID:", clientId);
        stream.getTracks().forEach((track) => {
          console.log("Local track:", track.kind, track.readyState, track.enabled);
        });
        setLocalStream(stream);
        await joinRoom(id);
      } catch (err) {
        console.error("Error accessing media devices:", err);
      }
    };
    initRoom();

    // Cleanup
    return () => {
      console.log("Cleaning up local stream and peer connections");
      if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
      }
      Object.values(peerConnections.current).forEach((pc) => pc.close());
      peerConnections.current = {};
      unsubscribeFunctions.current.forEach((unsubscribe) => unsubscribe());
      unsubscribeFunctions.current = [];
    };
  }, []);

  const joinRoom = async (roomId: string) => {
    if (!roomId) {
      console.error("No roomId provided");
      return;
    }
    const roomRef = doc(db, "rooms", roomId);
    try {
      const roomSnapshot = await getDoc(roomRef);
      if (!roomSnapshot.exists()) {
        console.log("Creating new room:", roomId);
        await setDoc(roomRef, { participants: [] });
      }

      const participantsCollection = collection(db, "rooms", roomId, "participants");
      const unsubscribeParticipants = onSnapshot(
        participantsCollection,
        (snapshot) => {
          snapshot.docChanges().forEach(async (change) => {
            if (change.type === "added") {
              const data = change.doc.data();
              if (data?.id !== clientId && !peerConnections.current[data?.id || ""]) {
                console.log("Participant change detected:", data);
                await createPeerConnection(data?.id || "", roomRef, roomId);
              }
            } else if (change.type === "removed") {
              const data = change.doc.data();
              if (data?.id && peerConnections.current[data.id]) {
                console.log("Participant left:", data.id);
                peerConnections.current[data.id].close();
                delete peerConnections.current[data.id];
                setRemoteStreams(prev => {
                  const newMap = new Map(prev);
                  newMap.delete(data.id);
                  return newMap;
                });
              }
            }
          });
        },
        (error) => {
          console.error("Snapshot error for participants:", error);
        }
      );
      unsubscribeFunctions.current.push(unsubscribeParticipants);

      console.log("Adding client to participants:", clientId);
      await setDoc(doc(participantsCollection, clientId), { id: clientId });
    } catch (err) {
      console.error("Error joining room:", err);
    }
  };

  const createPeerConnection = async (peerId: string, roomRef: any, roomId: string) => {
    console.log("Initializing peer connection for:", peerId, "with roomId:", roomId);
    if (!roomId || typeof roomId !== "string") {
      console.error("Invalid roomId detected:", roomId);
      return;
    }

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

    // IMPORTANT: Set up ontrack handler BEFORE adding local tracks
    pc.ontrack = (event) => {
      console.log("ontrack event received:", {
        streamId: event.streams[0]?.id,
        trackKind: event.track.kind,
        trackEnabled: event.track.enabled,
        trackReadyState: event.track.readyState,
        streams: event.streams.length,
      });

      if (event.streams && event.streams[0]) {
        const stream = event.streams[0];
        console.log("Adding remote stream for peer:", peerId, "stream:", stream.id);
        
        setRemoteStreams(prev => {
          const newMap = new Map(prev);
          newMap.set(peerId, stream);
          return newMap;
        });

        // Handle track ended
        event.track.onended = () => {
          console.log("Track ended for peer:", peerId, "track:", event.track.kind);
          setRemoteStreams(prev => {
            const newMap = new Map(prev);
            const currentStream = newMap.get(peerId);
            if (currentStream) {
              const liveTracks = currentStream.getTracks().filter(t => t.readyState === "live");
              if (liveTracks.length === 0) {
                newMap.delete(peerId);
              }
            }
            return newMap;
          });
        };
      }
    };

    // Add local stream tracks AFTER setting up ontrack
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        console.log("Adding track to peer connection:", track.kind, track.id, track.readyState);
        pc.addTrack(track, localStream);
      });
    }

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("Sending ICE candidate to:", peerId, "type:", event.candidate.type);
        const candidatesCollection = collection(db, "rooms", roomId, "candidates");
        addDoc(candidatesCollection, {
          candidate: event.candidate,
          to: peerId,
          from: clientId,
        }).catch((err) => console.error("Error sending ICE candidate:", err));
      }
    };

    // Monitor peer connection state
    pc.onconnectionstatechange = () => {
      console.log("Peer connection state for", peerId, ":", pc.connectionState);
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        console.error("Peer connection failed for", peerId);
        pc.close();
        delete peerConnections.current[peerId];
        setRemoteStreams(prev => {
          const newMap = new Map(prev);
          newMap.delete(peerId);
          return newMap;
        });
      } else if (pc.connectionState === "connected") {
        console.log("Peer connection established with", peerId);
      }
    };

    // Set up signaling listeners
    await setupSignalingListeners(pc, peerId, roomId);

    // Create and send offer
    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await pc.setLocalDescription(offer);
      console.log("Created and sent offer for:", peerId, "in room:", roomId);
      const offersCollection = collection(db, "rooms", roomId, "offers");
      await setDoc(doc(offersCollection, peerId), { 
        offer: offer, 
        from: clientId 
      });
    } catch (err) {
      console.error("Error creating/sending offer:", err);
    }
  };

  const setupSignalingListeners = async (pc: RTCPeerConnection, peerId: string, roomId: string) => {
    // Listen for incoming offers
    const offersCollection = collection(db, "rooms", roomId, "offers");
    const unsubscribeOffers = onSnapshot(
      doc(offersCollection, clientId),
      async (docSnap) => {
        try {
          const data = docSnap.data();
          if (data?.offer && data.from === peerId && !pc.remoteDescription) {
            console.log("Received offer from:", data.from);
            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            const answersCollection = collection(db, "rooms", roomId, "answers");
            await setDoc(doc(answersCollection, data.from), { 
              answer: answer, 
              from: clientId 
            });
            console.log("Sent answer to:", data.from);
            // Clean up the offer
            await deleteDoc(doc(offersCollection, clientId));
          }
        } catch (err) {
          console.error("Error processing offer:", err);
        }
      }
    );
    unsubscribeFunctions.current.push(unsubscribeOffers);

    // Listen for answers
    const answersCollection = collection(db, "rooms", roomId, "answers");
    const unsubscribeAnswers = onSnapshot(
      doc(answersCollection, clientId),
      async (docSnap) => {
        try {
          const data = docSnap.data();
          if (data?.answer && data.from === peerId && !pc.remoteDescription) {
            console.log("Received answer from:", data.from);
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            // Clean up the answer
            await deleteDoc(doc(answersCollection, clientId));
          }
        } catch (err) {
          console.error("Error processing answer:", err);
        }
      }
    );
    unsubscribeFunctions.current.push(unsubscribeAnswers);

    // Listen for ICE candidates
    const candidatesCollection = collection(db, "rooms", roomId, "candidates");
    const unsubscribeCandidates = onSnapshot(
      candidatesCollection,
      (snapshot) => {
        snapshot.docChanges().forEach(async (change) => {
          if (change.type === "added") {
            const data = change.doc.data();
            if (data.to === clientId && data.from === peerId) {
              console.log("Received ICE candidate from:", data.from);
              try {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                // Clean up the candidate
                await deleteDoc(change.doc.ref);
              } catch (err) {
                console.error("Error adding ICE candidate:", err);
              }
            }
          }
        });
      }
    );
    unsubscribeFunctions.current.push(unsubscribeCandidates);
  };

  const startScreenShare = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      setIsSharingScreen(true);
      
      // Replace tracks in all peer connections
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
        video: { facingMode: "user" },
        audio: true,
      });
      console.log("Restored camera stream:", stream.id);
      setLocalStream(stream);
      
      // Replace tracks in all peer connections
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
    setTimeout(() => recorder.stop(), 30000); // Stop after 30s for demo
  };

  const copyInviteLink = () => {
    const baseUrl = window.location.origin;
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

  // Clean up when component unmounts
  useEffect(() => {
    return () => {
      leaveRoom();
    };
  }, []);

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
      </div>
    </div>
  );
};

export default VideoCall;