import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import About from "./About";
import Explorer from "./Explorer";

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/2027/nep" replace />} />
        <Route path="/about" element={<About />} />
        <Route path="/:year/:view/n/:nodeKey" element={<Explorer />} />
        <Route path="/:year/:view" element={<Explorer />} />
        <Route path="*" element={<Navigate to="/2027/nep" replace />} />
      </Routes>
    </HashRouter>
  );
}
