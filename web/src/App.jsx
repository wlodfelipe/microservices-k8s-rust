import { Route, Routes } from 'react-router-dom';
import Header from './components/Header';
import Footer from './components/Footer';
import Home from './pages/Home';
import Auth from './pages/Auth';
import Settings from './pages/Settings';
import Editor from './pages/Editor';
import Article from './pages/Article';
import Profile from './pages/Profile';
import Monitor from './pages/Monitor';

export default function App() {
  return (
    <>
      <Header />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Auth mode="login" />} />
          <Route path="/register" element={<Auth mode="register" />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/editor" element={<Editor />} />
          <Route path="/editor/:slug" element={<Editor />} />
          <Route path="/article/:slug" element={<Article />} />
          <Route path="/profile/:username" element={<Profile />} />
          <Route path="/profile/:username/favorites" element={<Profile favorites />} />
          <Route path="/monitor" element={<Monitor />} />
          <Route path="*" element={<div className="container page"><h2>Página não encontrada</h2></div>} />
        </Routes>
      </main>
      <Footer />
    </>
  );
}
