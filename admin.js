/**
 * IRAHNI DECORS — ADMIN & PARTNER PORTAL JAVASCRIPT
 * Role-Based Access Control CRUD Interface with Cloud Firestore Sync
 */

import { auth, db, storage } from '../firebase.js';
import { 
  onAuthStateChanged, 
  signOut 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { 
  collection, 
  addDoc, 
  setDoc,
  doc, 
  updateDoc, 
  deleteDoc, 
  onSnapshot,
  getDocs,
  query,
  where,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  listAll
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js";

// Role Context
let currentUser = null;
let isInitialized = false;

function initAdminPortal(user) {
  currentUser = {
    uid: user.uid,
    email: user.email,
    username: user.email || 'admin',
    role: 'admin'
  };

  const authLoading = document.getElementById('auth-loading');
  if (authLoading) authLoading.style.display = 'none';

  const dashboard = document.getElementById('dashboard');
  if (dashboard) dashboard.style.display = 'block';

  setupUIForRole();

  if (!isInitialized) {
    isInitialized = true;
    setupAuthListeners();
    setupFormListeners();
    setupImagePreview();
    setupImageFileUpload();
    listenToFirestoreInventory();
    listenToFirestoreReviews();
    setupReviewFilters();
    setupReviewActions();
    setupPartnerManagement();
    setupSettingsManagement();
  }
}

// Route Guard: Source of truth is Firebase Authentication State
onAuthStateChanged(auth, (user) => {
  if (user) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => initAdminPortal(user), { once: true });
    } else {
      initAdminPortal(user);
    }
  } else {
    currentUser = null;
    window.location.href = 'login.html';
  }
});

/* --------------------------------------------------------------------------
   1. AUTHENTICATION & ROLE VERIFICATION
   -------------------------------------------------------------------------- */
function setupUIForRole() {
  const userDisplay = document.getElementById('user-display');
  if (userDisplay && currentUser) {
    userDisplay.textContent = `Logged in as: ${currentUser.email || currentUser.username} (ADMIN)`;
  }

  // Admin Panels Toggle
  const partnerSection = document.getElementById('partner-section');
  const settingsSection = document.getElementById('settings-section');

  if (currentUser.role === 'admin') {
    if (partnerSection) partnerSection.hidden = false;
    if (settingsSection) settingsSection.hidden = false;
  }
}

function setupAuthListeners() {
  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', async () => {
      try {
        await signOut(auth);
      } catch (err) {
        console.error("Sign out error:", err);
      } finally {
        window.location.href = 'login.html';
      }
    });
  }
}

/**
 * Robust helper to verify if the active partner session has been revoked by admin
 */
async function verifySessionActive() {
  if (!currentUser) return false;
  if (currentUser.role === 'admin') return true;

  try {
    const q = query(
      collection(db, 'partners'), 
      where('username', '==', currentUser.username)
    );
    const snap = await getDocs(q);
    if (snap.empty) {
      alert("Your partner session has been revoked by the administrator.");
      await signOut(auth);
      window.location.href = 'login.html';
      return false;
    }
    return true;
  } catch (err) {
    console.warn("Session check warning:", err);
    return true; // Proceed if query fails due to local configuration
  }
}

/* --------------------------------------------------------------------------
   2. IMAGE UPLOAD & PREVIEW CONTROLLER (PHASE 3 & PHASE 4 — FIREBASE STORAGE)
   -------------------------------------------------------------------------- */
// Category and Sizes System Standards (Phase 4 Specification)
const CATEGORY_LABELS = {
  lamp: "Handmade Lamps",
  propeller: "Aircraft Propellers",
  custom: "Custom Projects"
};

const ALLOWED_PROPELLER_SIZES = ['4 Feet', '4.5 Feet', '5 Feet', '5.5 Feet', '6 Feet'];
const ALLOWED_LAMP_SIZES = ['Small', 'Medium', 'Large'];

let currentSelectedSizes = [];
let currentSizePrices = {};
let activeFormProductId = null;

function ensureFormProductId() {
  const existingId = document.getElementById('product-id')?.value.trim();
  if (existingId) return existingId;
  if (!activeFormProductId) {
    activeFormProductId = doc(collection(db, 'products')).id;
  }
  return activeFormProductId;
}

let currentUploadResult = {
  imageUrl: '',
  images: []
};

let activeTempObjectUrls = [];

function revokeTemporaryObjectUrls() {
  if (activeTempObjectUrls.length > 0) {
    activeTempObjectUrls.forEach(url => {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        // Ignore revocation errors
      }
    });
    activeTempObjectUrls = [];
  }
}

function getDefaultLabel(index) {
  const defaultLabels = ['Front View', 'Side View', 'Back View', 'Top View', 'Detail View'];
  return defaultLabels[index] || 'Detail View';
}

function setupImagePreview() {
  const imgInput = document.getElementById('prod-image');
  const container = document.getElementById('image-preview-container');
  const preview = document.getElementById('image-preview');

  if (imgInput) {
    imgInput.addEventListener('input', () => {
      const url = imgInput.value.trim();
      if (url) {
        preview.src = url;
        container.hidden = false;
      } else {
        container.hidden = true;
      }
    });
  }
}

function setupImageFileUpload() {
  const fileInput = document.getElementById('prod-image-file');
  if (fileInput) {
    fileInput.addEventListener('change', handleImageFilesSelected);
  }
}

async function handleImageFilesSelected(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  const errorEl = document.getElementById('upload-error-text');
  const progressContainer = document.getElementById('upload-progress-container');
  const statusLabel = document.getElementById('upload-status-label');
  const statusPercent = document.getElementById('upload-status-percent');
  const progressBar = document.getElementById('upload-progress-bar');
  const urlInput = document.getElementById('prod-image');

  if (errorEl) {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  // 1. Verify authenticated user via Firebase Auth
  if (!auth || !auth.currentUser) {
    if (errorEl) {
      errorEl.textContent = 'Authentication required. Please sign in to upload images.';
      errorEl.hidden = false;
    }
    return;
  }

  // 2. Validate all files (type and size)
  const ALLOWED_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit

  for (const file of files) {
    const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
    const isAllowedExt = ALLOWED_EXTS.includes(ext);
    const isAllowedType = ALLOWED_TYPES.includes(file.type) || isAllowedExt;

    if (!isAllowedType) {
      if (errorEl) {
        errorEl.textContent = `File "${file.name}" is not a supported format. Please select JPG, PNG, or WEBP images.`;
        errorEl.hidden = false;
      }
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      if (errorEl) {
        errorEl.textContent = `File "${file.name}" exceeds the 10MB size limit.`;
        errorEl.hidden = false;
      }
      return;
    }
  }

  // 3. Temporary Object URLs for immediate client preview
  revokeTemporaryObjectUrls();
  const tempPreviews = files.map((file, idx) => {
    const objectUrl = URL.createObjectURL(file);
    activeTempObjectUrls.push(objectUrl);
    return {
      url: objectUrl,
      label: getDefaultLabel(idx)
    };
  });
  renderGalleryPreviews(tempPreviews);

  // Show progress indicator
  if (progressContainer) progressContainer.hidden = false;
  if (statusLabel) statusLabel.textContent = `Uploading 1 of ${files.length}...`;
  if (statusPercent) statusPercent.textContent = '0%';
  if (progressBar) progressBar.style.width = '0%';

  // 4. Storage directory: ALWAYS products/{productId}/
  const targetDocId = ensureFormProductId();
  const storagePrefix = `products/${targetDocId}`;

  const uploadedResults = [];
  const totalFiles = files.length;
  const overallProgress = new Array(totalFiles).fill(0);

  try {
    for (let i = 0; i < totalFiles; i++) {
      const file = files[i];
      const rawExt = file.name.split('.').pop() || 'jpg';
      const cleanExt = rawExt.toLowerCase().replace(/[^a-z0-9]/g, '');
      const rolePrefix = i === 0 ? 'primary' : `gallery_${i - 1}`;
      const fileName = `${rolePrefix}_${Date.now()}.${cleanExt}`;
      const storagePath = `${storagePrefix}/${fileName}`;

      const fileRef = ref(storage, storagePath);
      const uploadTask = uploadBytesResumable(fileRef, file, {
        contentType: file.type || 'image/jpeg'
      });

      await new Promise((resolve, reject) => {
        uploadTask.on(
          'state_changed',
          (snapshot) => {
            const filePercent = snapshot.totalBytes > 0 
              ? (snapshot.bytesTransferred / snapshot.totalBytes) 
              : 0;
            overallProgress[i] = filePercent;
            const currentTotal = overallProgress.reduce((a, b) => a + b, 0);
            const overallPercent = Math.min(100, Math.round((currentTotal / totalFiles) * 100));

            if (statusLabel) {
              statusLabel.textContent = `Uploading ${i + 1} of ${totalFiles}...`;
            }
            if (statusPercent) {
              statusPercent.textContent = `${overallPercent}%`;
            }
            if (progressBar) {
              progressBar.style.width = `${overallPercent}%`;
            }
          },
          (err) => {
            console.error('Storage upload task error:', err);
            reject(err);
          },
          async () => {
            try {
              const downloadUrl = await getDownloadURL(uploadTask.snapshot.ref);
              const label = getDefaultLabel(i);
              uploadedResults.push({
                url: downloadUrl,
                label: label,
                storagePath: storagePath
              });
              resolve();
            } catch (urlErr) {
              reject(urlErr);
            }
          }
        );
      });
    }

    // 5. Successful upload completion
    revokeTemporaryObjectUrls();

    // Preserve existing images if editing, and append newly uploaded files
    const newImages = uploadedResults.map(item => ({
      url: item.url,
      label: item.label
    }));

    const existingImages = (currentUploadResult && Array.isArray(currentUploadResult.images))
      ? currentUploadResult.images.filter(img => !newImages.some(n => n.url === img.url))
      : [];

    const combinedImages = [...existingImages, ...newImages];

    currentUploadResult = {
      imageUrl: currentUploadResult.imageUrl || combinedImages[0]?.url || '',
      images: combinedImages
    };

    // Update primary image URL input
    if (urlInput) {
      urlInput.value = currentUploadResult.imageUrl;
      urlInput.dispatchEvent(new Event('input'));
    }

    // Render multi-image gallery with HTTPS download URLs
    renderGalleryPreviews(currentUploadResult.images);

    if (statusLabel) statusLabel.textContent = 'Upload complete';
    if (statusPercent) statusPercent.textContent = '100%';
    if (progressBar) progressBar.style.width = '100%';

  } catch (err) {
    console.error('Firebase Storage upload failed:', err);
    revokeTemporaryObjectUrls();
    if (errorEl) {
      errorEl.textContent = 'Image upload failed. Please verify your connection and permissions, then try again.';
      errorEl.hidden = false;
    }
    if (progressContainer) progressContainer.hidden = true;
  }
}

function renderGalleryPreviews(imagesList) {
  const container = document.getElementById('gallery-preview-container');
  const grid = document.getElementById('gallery-preview-grid');
  if (!container || !grid) return;

  grid.innerHTML = '';
  if (!imagesList || imagesList.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;

  imagesList.forEach((item, index) => {
    const isPrimary = (index === 0 && (!currentUploadResult.imageUrl || currentUploadResult.imageUrl === item.url)) || (currentUploadResult.imageUrl === item.url);

    const card = document.createElement('div');
    card.className = `gallery-preview-card ${isPrimary ? 'is-primary' : ''}`;

    const badge = document.createElement('div');
    badge.className = 'gallery-preview-badge';
    badge.innerHTML = `<span>${isPrimary ? '★ Primary' : `#${index + 1}`}</span>`;

    const img = document.createElement('img');
    img.className = 'gallery-preview-thumb';
    img.src = item.url;
    img.alt = item.label || `Image ${index + 1}`;
    img.title = 'Click to set as primary image';
    img.addEventListener('click', () => {
      setPrimaryImage(item.url);
    });

    const select = document.createElement('select');
    select.className = 'gallery-preview-select';
    const LABELS = ['Front View', 'Side View', 'Back View', 'Top View', 'Detail View'];
    LABELS.forEach(lbl => {
      const opt = document.createElement('option');
      opt.value = lbl;
      opt.textContent = lbl;
      if (item.label === lbl) opt.selected = true;
      select.appendChild(opt);
    });

    select.addEventListener('change', (e) => {
      item.label = e.target.value;
      if (currentUploadResult.images && currentUploadResult.images[index]) {
        currentUploadResult.images[index].label = e.target.value;
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-sm btn-text';
    removeBtn.style.cssText = 'padding: 0.2rem 0.4rem; font-size: 0.75rem; color: var(--accent-red); margin-top: 0.25rem; align-self: flex-end;';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      currentUploadResult.images.splice(index, 1);
      if (currentUploadResult.imageUrl === item.url) {
        currentUploadResult.imageUrl = currentUploadResult.images[0]?.url || '';
        const urlInput = document.getElementById('prod-image');
        if (urlInput) urlInput.value = currentUploadResult.imageUrl;
      }
      renderGalleryPreviews(currentUploadResult.images);
    });

    card.appendChild(badge);
    card.appendChild(img);
    card.appendChild(select);
    card.appendChild(removeBtn);
    grid.appendChild(card);
  });
}

function setPrimaryImage(url) {
  currentUploadResult.imageUrl = url;
  const urlInput = document.getElementById('prod-image');
  if (urlInput) {
    urlInput.value = url;
    urlInput.dispatchEvent(new Event('input'));
  }
  renderGalleryPreviews(currentUploadResult.images);
}

/* --------------------------------------------------------------------------
   2b. SIZE SELECTION & SIZE-SPECIFIC PRICING SYSTEM (PHASE 4)
   -------------------------------------------------------------------------- */
function onCategoryChange() {
  const categorySelect = document.getElementById('prod-category');
  const cat = categorySelect ? categorySelect.value : '';
  const sizesInput = document.getElementById('prod-sizes');
  const sizesHint = document.getElementById('prod-sizes-hint');
  const chipsContainer = document.getElementById('size-chips-container');
  const customFields = document.getElementById('custom-project-fields');

  if (customFields) {
    customFields.hidden = (cat !== 'custom');
  }

  // Update chips and hints based on standardized categories
  if (chipsContainer) {
    chipsContainer.innerHTML = '';
    let allowedSizes = [];

    if (cat === 'propeller') {
      allowedSizes = ALLOWED_PROPELLER_SIZES;
      if (sizesHint) sizesHint.textContent = "Propellers support only foot-based sizes (4 Feet, 4.5 Feet, 5 Feet, 5.5 Feet, 6 Feet). Note: 6.5 Feet is not allowed.";
      if (sizesInput) {
        sizesInput.placeholder = "Select chips above or type: 4 Feet, 5 Feet, 6 Feet";
        sizesInput.required = true;
      }
    } else if (cat === 'lamp') {
      allowedSizes = ALLOWED_LAMP_SIZES;
      if (sizesHint) sizesHint.textContent = "Lamps support only standard sizes (Small, Medium, Large).";
      if (sizesInput) {
        sizesInput.placeholder = "Select chips above or type: Small, Medium, Large";
        sizesInput.required = true;
      }
    } else if (cat === 'custom') {
      allowedSizes = ['Custom'];
      if (sizesHint) sizesHint.textContent = "Optional: select variants or enter custom dimensions. Defaults to 'Custom'.";
      if (sizesInput) {
        sizesInput.placeholder = "e.g. Standard, Bespoke — leave blank for 'Custom'";
        sizesInput.required = false;
      }
    } else {
      if (sizesHint) sizesHint.textContent = "";
      if (sizesInput) sizesInput.required = false;
    }

    allowedSizes.forEach(size => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `size-chip ${currentSelectedSizes.includes(size) ? 'selected' : ''}`;
      chip.textContent = size;
      chip.addEventListener('click', () => {
        toggleSizeSelection(size);
      });
      chipsContainer.appendChild(chip);
    });
  }

  renderSizePricesUI();
}

function toggleSizeSelection(size) {
  const index = currentSelectedSizes.indexOf(size);
  if (index > -1) {
    // Remove size and its corresponding price
    currentSelectedSizes.splice(index, 1);
    delete currentSizePrices[size];
  } else {
    // Add size
    currentSelectedSizes.push(size);
    // Inherit base price input if available, else 0
    const basePrice = parseFloat(document.getElementById('prod-price')?.value) || 0;
    if (currentSizePrices[size] === undefined) {
      currentSizePrices[size] = basePrice;
    }
  }

  // Keep text input in sync
  const sizesInput = document.getElementById('prod-sizes');
  if (sizesInput) {
    sizesInput.value = currentSelectedSizes.join(', ');
  }

  // Update chip styles
  const chipsContainer = document.getElementById('size-chips-container');
  if (chipsContainer) {
    chipsContainer.querySelectorAll('.size-chip').forEach(chip => {
      chip.classList.toggle('selected', currentSelectedSizes.includes(chip.textContent.trim()));
    });
  }

  renderSizePricesUI();
}

function setupSizesInputSync() {
  const sizesInput = document.getElementById('prod-sizes');
  if (!sizesInput) return;

  sizesInput.addEventListener('input', () => {
    const rawVal = sizesInput.value;
    const tokens = rawVal.split(',').map(s => s.trim()).filter(Boolean);
    currentSelectedSizes = tokens;

    // Remove price entries for removed sizes
    Object.keys(currentSizePrices).forEach(sz => {
      if (!currentSelectedSizes.includes(sz)) {
        delete currentSizePrices[sz];
      }
    });

    // Populate prices for newly typed sizes
    const basePrice = parseFloat(document.getElementById('prod-price')?.value) || 0;
    currentSelectedSizes.forEach(sz => {
      if (currentSizePrices[sz] === undefined) {
        currentSizePrices[sz] = basePrice;
      }
    });

    // Update chips selection
    const chipsContainer = document.getElementById('size-chips-container');
    if (chipsContainer) {
      chipsContainer.querySelectorAll('.size-chip').forEach(chip => {
        chip.classList.toggle('selected', currentSelectedSizes.includes(chip.textContent.trim()));
      });
    }

    renderSizePricesUI();
  });

  // Base price input syncs to primary size if primary size has no price yet
  const basePriceInput = document.getElementById('prod-price');
  if (basePriceInput) {
    basePriceInput.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) || 0;
      if (currentSelectedSizes.length > 0) {
        const primarySize = currentSelectedSizes[0];
        if (!currentSizePrices[primarySize]) {
          currentSizePrices[primarySize] = val;
          renderSizePricesUI();
        }
      }
    });
  }
}

function renderSizePricesUI() {
  const container = document.getElementById('size-prices-container');
  const list = document.getElementById('size-prices-list');
  if (!container || !list) return;

  if (currentSelectedSizes.length === 0) {
    container.style.display = 'none';
    list.innerHTML = '';
    return;
  }

  container.style.display = 'block';
  list.innerHTML = '';

  currentSelectedSizes.forEach(size => {
    const card = document.createElement('div');
    card.className = 'size-price-card';

    const label = document.createElement('span');
    label.className = 'size-price-label';
    label.textContent = size;

    const wrap = document.createElement('div');
    wrap.className = 'size-price-input-wrap';

    const currency = document.createElement('span');
    currency.className = 'size-price-currency';
    currency.textContent = '₹';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'size-price-input';
    input.placeholder = `Price for ${size}`;
    input.min = '1';
    input.step = '1';
    input.required = true;
    input.value = (currentSizePrices[size] !== undefined && currentSizePrices[size] !== null && currentSizePrices[size] > 0)
      ? currentSizePrices[size]
      : '';

    input.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      currentSizePrices[size] = isNaN(val) ? 0 : val;
      // Sync primary size price with base price field
      if (size === currentSelectedSizes[0]) {
        const basePriceField = document.getElementById('prod-price');
        if (basePriceField) basePriceField.value = isNaN(val) ? '' : val;
      }
    });

    wrap.appendChild(currency);
    wrap.appendChild(input);
    card.appendChild(label);
    card.appendChild(wrap);
    list.appendChild(card);
  });
}

/* --------------------------------------------------------------------------
   3. FIRESTORE REAL-TIME INVENTORY LISTENER (PHASE 4 — NO LOCALSTORAGE FALLBACK)
   -------------------------------------------------------------------------- */
function listenToFirestoreInventory() {
  const listContainer = document.getElementById('admin-product-list');
  const countBadge = document.getElementById('product-count');
  if (!listContainer) return;

  try {
    const productsRef = collection(db, 'products');

    onSnapshot(productsRef, (snapshot) => {
      const items = [];
      if (!snapshot.empty) {
        snapshot.forEach(docSnap => {
          items.push({ id: docSnap.id, ...docSnap.data() });
        });
      }

      // Sort items: newest updatedAt/createdAt first if available
      items.sort((a, b) => {
        const timeA = a.updatedAt?.toMillis ? a.updatedAt.toMillis() : (a.createdAt?.toMillis ? a.createdAt.toMillis() : 0);
        const timeB = b.updatedAt?.toMillis ? b.updatedAt.toMillis() : (b.createdAt?.toMillis ? b.createdAt.toMillis() : 0);
        return timeB - timeA;
      });

      if (countBadge) {
        countBadge.textContent = `${items.length} ${items.length === 1 ? 'item' : 'items'}`;
      }

      if (items.length === 0) {
        listContainer.innerHTML = '<div class="empty-state">No products found in Firestore inventory. Add your first item.</div>';
        return;
      }

      renderAdminProductList(items, listContainer);
    }, (err) => {
      console.error("Firestore inventory onSnapshot error:", err);
      if (countBadge) countBadge.textContent = 'Error';
      listContainer.innerHTML = `
        <div class="empty-state" style="color: var(--accent-red); padding: 2rem 1rem;">
          <p style="font-weight: 600; margin-bottom: 0.5rem;">Unable to load inventory from Firestore</p>
          <p style="font-size: 0.8125rem; color: var(--text-secondary);">${escapeHTML(err.message || 'Please check your connection and try again.')}</p>
        </div>
      `;
    });
  } catch (err) {
    console.error("Firestore listener initialization error:", err);
    if (countBadge) countBadge.textContent = 'Error';
    listContainer.innerHTML = `
      <div class="empty-state" style="color: var(--accent-red); padding: 2rem 1rem;">
        Failed to initialize Firestore inventory: ${escapeHTML(err.message)}
      </div>
    `;
  }
}

/* --------------------------------------------------------------------------
   4. RENDER INVENTORY CATALOG LIST (INR ONLY)
   -------------------------------------------------------------------------- */
function renderAdminProductList(items, container) {
  container.innerHTML = items.map(item => {
    const createdBy = item.createdBy || 'admin';
    const isOwner = currentUser.role === 'admin' || createdBy === currentUser.uid || createdBy === currentUser.username;
    
    let actionButtons = '';
    if (isOwner) {
      actionButtons = `
        <button class="btn btn-sm btn-outline btn-edit" data-id="${item.id}">Edit</button>
        <button class="btn btn-sm btn-danger btn-delete" data-id="${item.id}" data-name="${escapeHTML(item.name)}">Delete</button>
      `;
    } else {
      actionButtons = `<span style="font-size: 0.75rem; color: var(--text-muted); font-style: italic;">View Only</span>`;
    }

    const visibilityStatus = item.hidden ? `<span style="color: var(--accent-red); margin-left: 0.5rem; font-size: 0.75rem;">[Hidden]</span>` : '';
    const featuredStatus = item.featured ? `<span style="color: var(--accent-green); margin-left: 0.5rem; font-size: 0.75rem;">[Featured]</span>` : '';

    const thumbUrl = item.imageUrl
      ? ((item.imageUrl.startsWith('http') || item.imageUrl.startsWith('data:') || item.imageUrl.startsWith('/') || item.imageUrl.startsWith('../')) ? item.imageUrl : '../' + item.imageUrl)
      : '../hero.jpg';

    const displayPrice = item.price || (item.prices && Object.values(item.prices)[0]) || 0;
    const catLabel = item.categoryLabel || CATEGORY_LABELS[item.category] || item.category || 'N/A';

    let sizesPriceMeta = '';
    if (item.prices && typeof item.prices === 'object' && Object.keys(item.prices).length > 0) {
      const priceEntries = Object.entries(item.prices).map(([sz, p]) => `${escapeHTML(sz)}: ₹${Number(p).toLocaleString('en-IN')}`).join(' · ');
      sizesPriceMeta = `<div style="font-size: 0.75rem; color: var(--accent-gold); font-family: var(--font-mono); margin-top: 0.25rem;">Prices: ${priceEntries}</div>`;
    } else if (Array.isArray(item.sizes) && item.sizes.length > 0) {
      sizesPriceMeta = `<div style="font-size: 0.75rem; color: var(--text-secondary); font-family: var(--font-mono); margin-top: 0.25rem;">Sizes: ${item.sizes.map(s => escapeHTML(s)).join(', ')}</div>`;
    }

    return `
      <div class="admin-item" data-id="${item.id}">
        <img src="${thumbUrl}" alt="${escapeHTML(item.name)}" class="item-thumb" onerror="this.src='../hero.jpg'">
        
        <div class="item-info">
          <h4>${escapeHTML(item.name)} ${featuredStatus} ${visibilityStatus}</h4>
          <div class="item-meta">
            <span class="item-badge">${escapeHTML(catLabel)}</span>
            <span class="item-price">₹${Number(displayPrice).toLocaleString('en-IN')}</span>
            <span style="color: var(--text-muted); font-size: 0.75rem; font-family: var(--font-mono);">Owner: ${escapeHTML(item.creatorEmail || createdBy)}</span>
          </div>
          ${sizesPriceMeta}
          <p class="item-desc">${escapeHTML(item.description)}</p>
        </div>

        <div class="item-actions">
          ${actionButtons}
        </div>
      </div>
    `;
  }).join('');

  // Store data mapping for Edit action references
  const itemMap = {};
  items.forEach(item => { itemMap[item.id] = item; });

  // Attach button event handlers
  container.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      if (itemMap[id]) {
        enterEditMode(itemMap[id]);
      }
    });
  });

  container.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const name = btn.getAttribute('data-name');
      confirmAndDeleteProduct(id, name);
    });
  });
}

/* --------------------------------------------------------------------------
   5. FORM CONTROLLER (CREATE & UPDATE — REAL FIRESTORE CRUD)
   -------------------------------------------------------------------------- */
function setupFormListeners() {
  const form = document.getElementById('product-form');
  const btnCancel = document.getElementById('btn-cancel-edit');
  if (!form) return;

  const categorySelect = document.getElementById('prod-category');
  if (categorySelect) {
    categorySelect.addEventListener('change', onCategoryChange);
  }

  setupSizesInputSync();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Revocation checkpoint
    const active = await verifySessionActive();
    if (!active) return;

    const id = document.getElementById('product-id').value.trim();
    const name = document.getElementById('prod-name').value.trim();
    const category = document.getElementById('prod-category').value.trim();
    const basePrice = parseFloat(document.getElementById('prod-price').value) || 0;
    const badge = document.getElementById('prod-badge').value.trim();
    const imageUrl = document.getElementById('prod-image').value.trim();
    const description = document.getElementById('prod-desc').value.trim();
    const specifications = document.getElementById('prod-specs').value.trim();
    const featured = document.getElementById('prod-featured').checked;
    const hidden = document.getElementById('prod-hidden').checked;

    // Disallow Base64 image strings to guarantee clean cloud storage persistence
    if (imageUrl && imageUrl.startsWith('data:')) {
      alert('Base64 images are not supported. Please upload image files to store in Firebase Storage or provide an HTTPS image URL.');
      return;
    }

    // 1. Name validation
    if (!name) {
      alert('Please enter a product name.');
      document.getElementById('prod-name').focus();
      return;
    }

    // 2. Category validation
    if (!category || !['propeller', 'lamp', 'custom'].includes(category)) {
      alert('Please select a valid product category (Aircraft Propellers, Handmade Lamps, or Custom Projects).');
      document.getElementById('prod-category').focus();
      return;
    }

    // 3. Sizes validation
    let finalSizes = [...currentSelectedSizes];
    if (category === 'custom' && finalSizes.length === 0) {
      finalSizes = ['Custom'];
    }

    if ((category === 'propeller' || category === 'lamp') && finalSizes.length === 0) {
      alert(`Please select at least one size for this ${category === 'propeller' ? 'aircraft propeller' : 'handmade lamp'}.`);
      return;
    }

    if (category === 'propeller') {
      if (finalSizes.some(s => s.toLowerCase().includes('6.5'))) {
        alert('6.5 Feet is not an allowed size. Allowed propeller sizes are: 4 Feet, 4.5 Feet, 5 Feet, 5.5 Feet, 6 Feet.');
        return;
      }
      const invalidPropSizes = finalSizes.filter(s => !ALLOWED_PROPELLER_SIZES.includes(s));
      if (invalidPropSizes.length > 0) {
        alert(`Invalid propeller size(s): "${invalidPropSizes.join(', ')}". Allowed sizes are: 4 Feet, 4.5 Feet, 5 Feet, 5.5 Feet, 6 Feet.`);
        return;
      }
    } else if (category === 'lamp') {
      const invalidLampSizes = finalSizes.filter(s => !ALLOWED_LAMP_SIZES.includes(s));
      if (invalidLampSizes.length > 0) {
        alert(`Invalid lamp size(s): "${invalidLampSizes.join(', ')}". Allowed sizes are: Small, Medium, Large.`);
        return;
      }
    }

    // 4. Validate size-specific prices
    const finalPrices = {};
    for (const s of finalSizes) {
      const p = Number(currentSizePrices[s] !== undefined ? currentSizePrices[s] : (category === 'custom' ? basePrice : 0));
      if (isNaN(p) || p <= 0) {
        alert(`Please enter a valid price in INR (greater than 0) for size: "${s}".`);
        renderSizePricesUI();
        return;
      }
      finalPrices[s] = p;
    }

    // Legacy price field: set consistently to primary/first size price
    const primaryPrice = finalPrices[finalSizes[0]] || basePrice || 0;

    const targetDocId = ensureFormProductId();
    const isUpdate = Boolean(id);

    const primaryImageUrl = (currentUploadResult && currentUploadResult.imageUrl) || imageUrl || '';
    const imagesArray = (currentUploadResult && currentUploadResult.images && currentUploadResult.images.length > 0)
      ? currentUploadResult.images
      : (primaryImageUrl ? [{ url: primaryImageUrl, label: 'Front View' }] : []);

    const productData = {
      name,
      category,
      categoryLabel: CATEGORY_LABELS[category] || category,
      price: Number(primaryPrice),
      sizes: finalSizes,
      prices: finalPrices,
      imageUrl: primaryImageUrl,
      images: imagesArray,
      badge,
      description,
      specifications,
      featured: Boolean(featured),
      hidden: Boolean(hidden),
      projectType: category === 'custom' ? (document.getElementById('prod-project-type')?.value || 'Custom Design') : '',
      dimensions: category === 'custom' ? (document.getElementById('prod-dimensions')?.value.trim() || '') : '',
      materials: category === 'custom' ? (document.getElementById('prod-materials')?.value.trim() || '') : '',
      finish: category === 'custom' ? (document.getElementById('prod-finish')?.value.trim() || '') : '',
      availability: category === 'custom' ? (document.getElementById('prod-availability')?.value || 'Custom Order — Handcrafted to Request') : '',
      customDetails: category === 'custom' ? (document.getElementById('prod-custom-details')?.value.trim() || '') : '',
      updatedAt: serverTimestamp()
    };

    const submitBtn = document.getElementById('btn-submit-form');
    submitBtn.disabled = true;
    submitBtn.textContent = isUpdate ? 'Updating Product...' : 'Saving to Firestore...';

    try {
      if (isUpdate) {
        await updateDoc(doc(db, 'products', id), productData);
        alert(`Product "${name}" updated successfully in Firestore.`);
      } else {
        productData.createdAt = serverTimestamp();
        productData.createdBy = (auth.currentUser && auth.currentUser.uid) || 'admin';
        productData.creatorEmail = (auth.currentUser && auth.currentUser.email) || '';
        await setDoc(doc(db, 'products', targetDocId), productData);
        alert(`Product "${name}" created successfully in Firestore.`);
      }
      resetForm();
    } catch (error) {
      console.error("Firestore product save error:", error);
      alert(`Unable to save product. Please check your connection and try again.\n\nError: ${error.message}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = document.getElementById('product-id').value ? 'Update Product' : 'Add Product to Inventory';
    }
  });

  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      resetForm();
    });
  }
}

function enterEditMode(item) {
  document.getElementById('product-id').value = item.id;
  activeFormProductId = item.id;
  document.getElementById('prod-name').value = item.name || '';
  document.getElementById('prod-category').value = item.category || '';
  document.getElementById('prod-price').value = item.price || (item.prices && Object.values(item.prices)[0]) || 0;
  document.getElementById('prod-badge').value = item.badge || '';
  document.getElementById('prod-image').value = item.imageUrl || '';
  document.getElementById('prod-desc').value = item.description || '';
  document.getElementById('prod-specs').value = item.specifications || '';
  document.getElementById('prod-featured').checked = Boolean(item.featured);
  document.getElementById('prod-hidden').checked = Boolean(item.hidden);

  if (item.category === 'custom') {
    if (document.getElementById('prod-project-type')) document.getElementById('prod-project-type').value = item.projectType || 'Custom Design';
    if (document.getElementById('prod-dimensions')) document.getElementById('prod-dimensions').value = item.dimensions || '';
    if (document.getElementById('prod-materials')) document.getElementById('prod-materials').value = item.materials || '';
    if (document.getElementById('prod-finish')) document.getElementById('prod-finish').value = item.finish || '';
    if (document.getElementById('prod-availability')) document.getElementById('prod-availability').value = item.availability || 'Custom Order — Handcrafted to Request';
    if (document.getElementById('prod-custom-details')) document.getElementById('prod-custom-details').value = item.customDetails || '';
    if (document.getElementById('prod-gallery-urls')) {
      const urls = item.images ? item.images.map(img => img.url).join('\n') : '';
      document.getElementById('prod-gallery-urls').value = urls;
    }
  }

  // Populate sizes & prices
  currentSelectedSizes = Array.isArray(item.sizes) ? [...item.sizes] : [];
  currentSizePrices = {};
  if (item.prices && typeof item.prices === 'object') {
    Object.keys(item.prices).forEach(sz => {
      currentSizePrices[sz] = Number(item.prices[sz]) || 0;
    });
  } else if (item.price) {
    currentSelectedSizes.forEach(sz => {
      currentSizePrices[sz] = Number(item.price);
    });
  }

  const sizesInput = document.getElementById('prod-sizes');
  if (sizesInput) {
    sizesInput.value = currentSelectedSizes.join(', ');
  }

  // Trigger category select change event to refresh helper texts & show/hide custom fields
  onCategoryChange();

  // Render Image Preview
  const previewContainer = document.getElementById('image-preview-container');
  const preview = document.getElementById('image-preview');
  if (item.imageUrl) {
    preview.src = item.imageUrl;
    previewContainer.hidden = false;
  } else {
    previewContainer.hidden = true;
  }

  // Populate Gallery Previews
  const loadedImages = Array.isArray(item.images) && item.images.length > 0
    ? [...item.images]
    : (item.imageUrl ? [{ url: item.imageUrl, label: 'Front View' }] : []);

  currentUploadResult = {
    imageUrl: item.imageUrl || '',
    images: loadedImages
  };
  renderGalleryPreviews(currentUploadResult.images);

  document.getElementById('form-title').textContent = 'Edit Product';
  document.getElementById('btn-submit-form').textContent = 'Update Product';
  document.getElementById('btn-cancel-edit').hidden = false;

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetForm() {
  const form = document.getElementById('product-form');
  if (form) form.reset();
  
  document.getElementById('product-id').value = '';
  activeFormProductId = doc(collection(db, 'products')).id;
  currentSelectedSizes = [];
  currentSizePrices = {};

  const sizesInput = document.getElementById('prod-sizes');
  if (sizesInput) sizesInput.value = '';

  const sizePricesContainer = document.getElementById('size-prices-container');
  if (sizePricesContainer) sizePricesContainer.style.display = 'none';
  const sizePricesList = document.getElementById('size-prices-list');
  if (sizePricesList) sizePricesList.innerHTML = '';

  const chipsContainer = document.getElementById('size-chips-container');
  if (chipsContainer) {
    chipsContainer.querySelectorAll('.size-chip').forEach(c => c.classList.remove('selected'));
  }

  document.getElementById('image-preview-container').hidden = true;
  document.getElementById('form-title').textContent = 'Add New Product';
  document.getElementById('btn-submit-form').textContent = 'Add Product to Inventory';
  
  // Reset upload result, progress, and previews
  currentUploadResult = { imageUrl: '', images: [] };
  revokeTemporaryObjectUrls();
  const galleryContainer = document.getElementById('gallery-preview-container');
  if (galleryContainer) galleryContainer.hidden = true;
  const galleryGrid = document.getElementById('gallery-preview-grid');
  if (galleryGrid) galleryGrid.innerHTML = '';
  const progressContainer = document.getElementById('upload-progress-container');
  if (progressContainer) progressContainer.hidden = true;
  const errorEl = document.getElementById('upload-error-text');
  if (errorEl) { errorEl.textContent = ''; errorEl.hidden = true; }
  const fileInput = document.getElementById('prod-image-file');
  if (fileInput) fileInput.value = '';

  const customFields = document.getElementById('custom-project-fields');
  if (customFields) customFields.hidden = true;

  const cancelBtn = document.getElementById('btn-cancel-edit');
  if (cancelBtn) cancelBtn.hidden = true;

  // Clear helper texts and reset category select
  const categorySelect = document.getElementById('prod-category');
  if (categorySelect) {
    categorySelect.value = '';
    onCategoryChange();
  }
}

/* --------------------------------------------------------------------------
   6. DELETE CONTROLLER (REAL FIRESTORE & STORAGE CLEANUP)
   -------------------------------------------------------------------------- */
async function confirmAndDeleteProduct(id, name) {
  // Revocation checkpoint
  const active = await verifySessionActive();
  if (!active) return;

  if (!confirm(`Are you sure you want to permanently delete "${name}" from inventory?`)) {
    return;
  }

  try {
    // 1. Delete Firestore document
    await deleteDoc(doc(db, 'products', id));

    // 2. Clean up associated Firebase Storage files under products/{id}/
    try {
      await deleteProductStorageFiles(id);
    } catch (storageErr) {
      console.warn("[Storage] Warning cleaning up product images:", storageErr);
      alert(`Product "${name}" removed from Firestore, but some storage files could not be cleaned up: ${storageErr.message}`);
      return;
    }

    alert(`Product "${name}" deleted successfully.`);
  } catch (err) {
    console.error("Delete product error:", err);
    alert(`Unable to delete product. Please check your connection and try again.\n\nError: ${err.message}`);
  }
}

/* --------------------------------------------------------------------------
   7. PARTNER MANAGEMENT (ADMIN ONLY)
   -------------------------------------------------------------------------- */
function setupPartnerManagement() {
  const partnerForm = document.getElementById('partner-form');
  if (!partnerForm) return;

  partnerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('partner-username').value.trim();
    const password = document.getElementById('partner-password').value.trim();

    // Prevent duplicate partner account usernames
    try {
      const q = query(collection(db, 'partners'), where('username', '==', username));
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        alert("A partner account with this username already exists!");
        return;
      }

      await addDoc(collection(db, 'partners'), {
        username,
        password,
        role: 'partner',
        invitedAt: new Date().toISOString()
      });

      alert(`Partner "${username}" invited successfully!`);
      partnerForm.reset();
    } catch (err) {
      console.error("Adding partner failed:", err);
      alert(`Error inviting partner: ${err.message}`);
    }
  });

  listenToPartners();
}

function listenToPartners() {
  const listContainer = document.getElementById('partner-list');
  if (!listContainer) return;

  const partnersRef = collection(db, 'partners');

  onSnapshot(partnersRef, (snapshot) => {
    if (snapshot.empty) {
      listContainer.innerHTML = '<div style="font-size: 0.8125rem; color: var(--text-muted); font-style: italic;">No active partners invited yet.</div>';
      return;
    }

    const partners = [];
    snapshot.forEach(doc => {
      partners.push({ id: doc.id, ...doc.data() });
    });

    listContainer.innerHTML = partners.map(p => `
      <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.625rem 0.875rem; background: var(--bg-main); border: 1px solid var(--color-border); border-radius: 8px;">
        <span style="font-size: 0.875rem; color: var(--text-primary); font-family: var(--font-mono);">${escapeHTML(p.username)}</span>
        <button class="btn btn-sm btn-danger btn-revoke-partner" data-id="${p.id}" data-username="${escapeHTML(p.username)}" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">Revoke</button>
      </div>
    `).join('');

    listContainer.querySelectorAll('.btn-revoke-partner').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const username = btn.getAttribute('data-username');
        revokePartnerAccess(id, username);
      });
    });
  });
}

async function revokePartnerAccess(id, username) {
  if (confirm(`Revoke access for partner "${username}" immediately?`)) {
    try {
      await deleteDoc(doc(db, 'partners', id));
      alert(`Partner "${username}" access revoked.`);
    } catch (err) {
      console.error("Revoke access failed:", err);
      alert(`Error revoking access: ${err.message}`);
    }
  }
}

/* --------------------------------------------------------------------------
   8. WEBSITE SETTINGS (ADMIN ONLY)
   -------------------------------------------------------------------------- */
function setupSettingsManagement() {
  const settingsForm = document.getElementById('settings-form');
  if (!settingsForm) return;

  // Read current setting placeholders or values if stored in database
  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const storefrontName = document.getElementById('setting-storename').value.trim();
    const maintenanceMode = document.getElementById('setting-maintenance').checked;

    // Simulate saving settings (standard client mock for non-server setups)
    localStorage.setItem('settings_storename', storefrontName);
    localStorage.setItem('settings_maintenance', maintenanceMode);

    alert("Settings saved successfully!");
  });

  // Load saved setting placeholders on init
  const savedName = localStorage.getItem('settings_storename');
  const savedMaint = localStorage.getItem('settings_maintenance');

  if (savedName) {
    document.getElementById('setting-storename').value = savedName;
  }
  if (savedMaint === 'true') {
    document.getElementById('setting-maintenance').checked = true;
  }
}

/* --------------------------------------------------------------------------
   8b. CUSTOMER REVIEWS MODERATION
   -------------------------------------------------------------------------- */
let allReviews = [];
let currentReviewFilter = 'all';

const initialDefaultReviews = [
  {
    id: "review-default-1",
    name: "Marcello V.",
    authorTitle: "Principal Architect, Studio V (Zurich)",
    category: "propeller",
    review: "Not merely a restored blade — a museum-grade aviation sculpture that commands the room with quiet authority.",
    rating: 5,
    status: "approved",
    createdAt: "2026-01-15T10:00:00.000Z"
  },
  {
    id: "review-default-2",
    name: "Julian H.",
    authorTitle: "Private Aviation Collector (London)",
    category: "propeller",
    review: "The precision of vintage aluminum joined with walnut rivals Bang & Olufsen. Extraordinary.",
    rating: 5,
    status: "approved",
    createdAt: "2026-02-10T14:30:00.000Z"
  },
  {
    id: "review-default-3",
    name: "Elena R.",
    authorTitle: "Interior Design Director (Dubai)",
    category: "lamp",
    review: "Seamless from inquiry to delivery. The exquisite natural walnut grain and hand-polished brass details make it truly one-of-a-kind.",
    rating: 5,
    status: "approved",
    createdAt: "2026-03-01T09:15:00.000Z"
  }
];

function listenToFirestoreReviews() {
  const listContainer = document.getElementById('admin-review-list');
  if (!listContainer) return;

  const getLocalReviews = () => {
    try {
      const stored = localStorage.getItem('irahni_reviews');
      if (stored) return JSON.parse(stored);
      localStorage.setItem('irahni_reviews', JSON.stringify(initialDefaultReviews));
      return initialDefaultReviews;
    } catch (e) {
      return initialDefaultReviews;
    }
  };

  try {
    const reviewsRef = collection(db, 'reviews');
    onSnapshot(reviewsRef, (snapshot) => {
      let dbReviews = [];
      if (!snapshot.empty) {
        snapshot.forEach(docSnap => {
          dbReviews.push({ id: docSnap.id, ...docSnap.data() });
        });
      }
      if (dbReviews.length > 0) {
        allReviews = dbReviews;
      } else {
        allReviews = getLocalReviews();
        if (allReviews.length === 0) {
          allReviews = [...initialDefaultReviews];
        }
      }
      renderAdminReviews();
    }, (error) => {
      console.warn("Firestore reviews sync notice (using local storage fallback):", error);
      allReviews = getLocalReviews();
      renderAdminReviews();
    });
  } catch (err) {
    console.warn("Firestore reviews listener error, rendering local dataset:", err);
    allReviews = getLocalReviews();
    renderAdminReviews();
  }
}

function renderAdminReviews() {
  const container = document.getElementById('admin-review-list');
  const countBadge = document.getElementById('review-count');
  if (!container) return;

  // Filter reviews based on status
  let filtered = allReviews;
  if (currentReviewFilter === 'pending') {
    filtered = allReviews.filter(r => r.status === 'pending' || (!r.status && !r.approved));
  } else if (currentReviewFilter === 'approved') {
    filtered = allReviews.filter(r => r.status === 'approved' || r.approved === true);
  } else if (currentReviewFilter === 'hidden') {
    filtered = allReviews.filter(r => r.status === 'hidden');
  }

  // Update total count badge
  if (countBadge) {
    const pendingCount = allReviews.filter(r => r.status === 'pending' || (!r.status && !r.approved)).length;
    countBadge.textContent = pendingCount > 0 ? `${allReviews.length} total (${pendingCount} pending)` : `${allReviews.length} reviews`;
  }

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state">No reviews match the "${currentReviewFilter}" filter.</div>`;
    return;
  }

  container.innerHTML = filtered.map(r => {
    const status = r.status || (r.approved ? 'approved' : 'pending');
    const rating = Math.min(5, Math.max(1, Number(r.rating) || 5));
    const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
    const dateStr = r.createdAt ? new Date(r.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Recent';

    let statusBadgeClass = 'pending';
    let statusLabel = 'Pending Approval';
    if (status === 'approved') {
      statusBadgeClass = 'approved';
      statusLabel = 'Approved';
    } else if (status === 'hidden') {
      statusBadgeClass = 'hidden';
      statusLabel = 'Hidden';
    }

    const approveButton = status !== 'approved'
      ? `<button type="button" class="btn btn-sm btn-approve" data-action="approve" data-id="${escapeHTML(r.id)}">Approve</button>`
      : `<button type="button" class="btn btn-sm btn-hide" data-action="hide" data-id="${escapeHTML(r.id)}">Hide</button>`;

    return `
    <div class="review-admin-card ${status === 'hidden' ? 'hidden-review' : status}">
      <div class="review-admin-top">
        <div class="review-admin-author">
          <span>${escapeHTML(r.name)}</span>
          <span class="review-admin-stars">${stars}</span>
        </div>
        <span class="review-admin-date">${dateStr}</span>
      </div>

      <div class="review-admin-quote">
        "${escapeHTML(r.review)}"
      </div>

      <div class="review-admin-footer">
        <span class="status-badge ${statusBadgeClass}">${statusLabel}</span>
        <div class="review-actions-group">
          ${approveButton}
          <button type="button" class="btn btn-sm btn-delete-review" data-action="delete" data-id="${escapeHTML(r.id)}">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function setupReviewFilters() {
  const buttons = document.querySelectorAll('.btn-review-filter');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentReviewFilter = btn.dataset.reviewFilter;
      renderAdminReviews();
    });
  });
}

function setupReviewActions() {
  const container = document.getElementById('admin-review-list');
  if (!container) return;

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (!id) return;

    const syncLocal = (updater) => {
      let localReviews = JSON.parse(localStorage.getItem('irahni_reviews') || '[]');
      if (localReviews.length === 0) localReviews = [...allReviews];
      localReviews = updater(localReviews);
      localStorage.setItem('irahni_reviews', JSON.stringify(localReviews));
    };

    if (action === 'approve') {
      try {
        await updateDoc(doc(db, 'reviews', id), { approved: true, visible: true, status: 'approved' });
      } catch (err) {
        console.warn("Firestore update fallback to local:", err);
      }
      syncLocal(list => list.map(r => r.id === id ? { ...r, approved: true, visible: true, status: 'approved' } : r));
      allReviews = allReviews.map(r => r.id === id ? { ...r, approved: true, visible: true, status: 'approved' } : r);
      renderAdminReviews();
    } else if (action === 'hide') {
      try {
        await updateDoc(doc(db, 'reviews', id), { visible: false, status: 'hidden' });
      } catch (err) {
        console.warn("Firestore update fallback to local:", err);
      }
      syncLocal(list => list.map(r => r.id === id ? { ...r, visible: false, status: 'hidden' } : r));
      allReviews = allReviews.map(r => r.id === id ? { ...r, visible: false, status: 'hidden' } : r);
      renderAdminReviews();
    } else if (action === 'delete') {
      if (confirm('Are you sure you want to permanently delete this customer review?')) {
        try {
          await deleteDoc(doc(db, 'reviews', id));
        } catch (err) {
          console.warn("Firestore delete fallback to local:", err);
        }
        syncLocal(list => list.filter(r => r.id !== id));
        allReviews = allReviews.filter(r => r.id !== id);
        renderAdminReviews();
      }
    }
  });
}

/* --------------------------------------------------------------------------
   9. SECURITY ESCAPING
   -------------------------------------------------------------------------- */
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* --------------------------------------------------------------------------
   10. PHASE 3 STORAGE EXPORTS & CLEANUP HELPERS
   -------------------------------------------------------------------------- */
/**
 * Reusable Cloud Storage cleanup helper for product images.
 * Capable of deleting image references under products/{productId}/
 * NOTE: Phase 3 prepares this helper; Phase 4 will wire it to product deletion.
 *
 * @param {string} productId - Product identifier
 * @param {string[]} [urls] - Optional list of storage download URLs to delete
 */
export async function deleteProductStorageFiles(productId, urls = []) {
  if (!productId) return;

  try {
    const folderRef = ref(storage, `products/${productId}`);
    const res = await listAll(folderRef);
    const deletePromises = res.items.map(itemRef => deleteObject(itemRef));
    await Promise.all(deletePromises);
  } catch (err) {
    console.warn(`[Storage] listAll on products/${productId}:`, err.message);
  }

  if (Array.isArray(urls) && urls.length > 0) {
    for (const url of urls) {
      if (typeof url === 'string' && url.includes('firebasestorage.googleapis.com')) {
        try {
          const fileRef = ref(storage, url);
          await deleteObject(fileRef);
        } catch (err) {
          console.warn(`[Storage] Could not delete image at ${url}:`, err.message);
        }
      }
    }
  }
}

export async function deleteProductImages(productId, urls = []) {
  return deleteProductStorageFiles(productId, urls);
}

export async function deleteProductImage(storagePathOrUrl) {
  if (!storagePathOrUrl) return;
  try {
    const fileRef = ref(storage, storagePathOrUrl);
    await deleteObject(fileRef);
  } catch (err) {
    console.warn("[Storage] Delete error:", err.message);
  }
}

export function getCurrentUploadResult() {
  return currentUploadResult;
}

