import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import TreeDashboard from "./pages/TreeDashboard";
import SettingsPage from "./pages/SettingsPage";
import "./App.css";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<TreeDashboard />} />
        <Route path="/project/:pinId" element={<TreeDashboard />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
