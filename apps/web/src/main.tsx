import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { HostScreen } from './HostScreen.js';
import './styles.css';

const hostScreen = new URLSearchParams(location.search).get('host') === '1';
createRoot(document.getElementById('root')!).render(hostScreen ? <HostScreen /> : <App />);
