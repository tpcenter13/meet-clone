import React, { useEffect, useRef } from "react";

interface VideoPlayerProps {
  stream: MediaStream | null;
  muted: boolean;
}

const VideoPlayer = ({ stream, muted }: VideoPlayerProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (videoElement && stream) {
      const currentStream = videoElement.srcObject as MediaStream | null;
      if (!currentStream || currentStream.id !== stream.id) {
        console.log("Setting video stream for:", stream.id);
        videoElement.srcObject = stream;
        videoElement
          .play()
          .catch((err) => console.error("Video play error:", err));
      }
    }
    return () => {
      if (videoElement && videoElement.srcObject) {
        const tracks = (videoElement.srcObject as MediaStream).getTracks();
        tracks.forEach((track) => track.stop());
        videoElement.srcObject = null;
      }
    };
  }, [stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      className="w-full rounded shadow"
    />
  );
};

export default VideoPlayer;