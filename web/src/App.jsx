import { Route, Routes } from 'react-router-dom';
import Returned from './components/Returned';
import Header from './components/Header';
import Footer, { useVersions } from './components/Footer';
import Home from './pages/Home';
import Auth from './pages/Auth';
import Settings from './pages/Settings';
import Editor from './pages/Editor';
import Article from './pages/Article';
import Profile from './pages/Profile';
import Monitor from './pages/Monitor';

function NotFound() {
  return <Returned message="There is no page at this address." />;
}

export default function App() {
  const status = useVersions();
  return (
    <>
      <Header />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Home versions={status.versions} />} />
          <Route path="/login" element={<Auth mode="login" />} />
          <Route path="/register" element={<Auth mode="register" />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/editor" element={<Editor />} />
          <Route path="/editor/:slug" element={<Editor />} />
          <Route path="/article/:slug" element={<Article />} />
          <Route path="/profile/:username" element={<Profile />} />
          <Route path="/profile/:username/favorites" element={<Profile favorites />} />
          <Route path="/monitor" element={<Monitor />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer status={status} />
    </>
  );
}
