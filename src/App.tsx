import { BrowserRouter } from "react-router-dom";
import VideoCall from "./components/VideoCall";
import "./index.css";

const App = () => {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-100">
        <VideoCall />
      </div>
    </BrowserRouter>
  );
};

export default App;