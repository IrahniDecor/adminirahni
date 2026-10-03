/**
 * IRAHNI DECORS — ADMIN PORTAL LOGIN SCRIPT
 * Authenticates administrator via Firebase Authentication (signInWithEmailAndPassword)
 */

import { auth } from '../firebase.js';
import { 
  signInWithEmailAndPassword, 
  onAuthStateChanged 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// If already authenticated with Firebase, redirect directly to dashboard
onAuthStateChanged(auth, (user) => {
  if (user) {
    window.location.href = 'index.html';
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  const loginError = document.getElementById('login-error');
  const submitBtn = document.getElementById('btn-login-submit');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');

  if (!loginForm) return;

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = emailInput ? emailInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';

    if (!email || !password) {
      loginError.textContent = "Please enter your email and password.";
      loginError.hidden = false;
      return;
    }

    loginError.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in...';

    try {
      await signInWithEmailAndPassword(auth, email, password);
      // On successful authentication, redirect to index.html
      window.location.href = 'index.html';
    } catch (err) {
      console.error("Authentication failed:", err.code);

      // User-friendly error messaging without exposing Firebase internal details
      let errorMsg = "Invalid email or password.";
      if (err.code === 'auth/too-many-requests') {
        errorMsg = "Too many unsuccessful attempts. Please try again later.";
      } else if (err.code === 'auth/network-request-failed') {
        errorMsg = "Network error. Please check your connection and try again.";
      } else if (err.code === 'auth/user-disabled') {
        errorMsg = "This admin account has been disabled.";
      }

      loginError.textContent = errorMsg;
      loginError.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In';
    }
  });
});
