import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './style.css';

import { signInAnonymously } from "firebase/auth";
import { auth } from "./firebase"; // 👈 AÑADIR ESTO

// 🔐 Login anónimo al arrancar la app
signInAnonymously(auth).catch((error) => {
  console.error("Error en auth anónima:", error);
});

const rootElement = document.getElementById('app');
if (!rootElement) {
  throw new Error('No se encontró el elemento #app');
}

try {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (error) {
  console.error('Error al renderizar la aplicación:', error);
  rootElement.innerHTML = `
    <div style="padding: 24px; color: white; text-align: center; background: rgba(15, 23, 42, 0.92); border-radius: 20px; margin: 24px;">
      <h1>Error al cargar la aplicación</h1>
      <p>Por favor, recarga la página.</p>
      <pre style="background: rgba(255,0,0,0.2); padding: 12px; border-radius: 8px; margin-top: 16px; text-align: left; overflow-x: auto; font-size: 12px;">
        ${error instanceof Error ? error.message : String(error)}
      </pre>
    </div>
  `;
}
