// Logs de depuração
const log = (msg) => {
    console.log(`[GlassBank] ${msg}`);
    const statusEl = document.getElementById('loading-status');
    if(statusEl) statusEl.innerText = msg;
};

log("Iniciando importação do Firebase...");

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, query, where, onSnapshot, runTransaction, serverTimestamp, limit, getDocs } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

log("Firebase importado. Configurando app...");

// --- CONFIGURAÇÃO (USE A SUA!) ---
const firebaseConfig = {
  apiKey: "AIzaSyBkl7Vt5WHMoiU3mThXiG7hAzv1T0FvSRI", // <--- VERIFIQUE SE ISSO ESTÁ CERTO
  authDomain: "glassbank-c411b.firebaseapp.com",
  projectId: "glassbank-c411b",
  storageBucket: "glassbank-c411b.firebasestorage.app",
  messagingSenderId: "222854977565",
  appId: "1:222854977565:web:c654f9a0dbf47665f7cef4"
};

let app, auth, db;

try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    log("Firebase conectado com sucesso.");
} catch (e) {
    console.error("Erro CRÍTICO ao conectar Firebase:", e);
    alert("Erro na configuração do Firebase. Abra o console (F12).");
}

const CITY_HALL_ID = "DIGITE_O_ID_DA_PREFEITURA_AQUI"; 

let currentUserData = null;
let html5QrcodeScanner = null;
let currentTaxRate = 0.02;

// --- EXPORTAR FUNÇÕES PARA O HTML (WINDOW) ---
// Isso corrige o erro de "função não encontrada"
window.navTo = (sectionId) => {
    console.log("Navegando para:", sectionId);
    document.querySelectorAll('section').forEach(s => s.classList.add('hidden'));
    
    // Tenta encontrar pelo ID direto ou com sufixo
    let target = document.getElementById(sectionId);
    if(!target) target = document.getElementById(sectionId + '-section');
    
    if(target) {
        target.classList.remove('hidden');
        if(sectionId === 'qr-scan') startScanner();
        else stopScanner();
    } else {
        console.error("ERRO: Seção não encontrada no HTML:", sectionId);
    }
};

window.toggleAuth = (mode) => {
    const isRegister = mode === 'register';
    document.getElementById('fullname').style.display = isRegister ? 'block' : 'none';
    document.getElementById('role-select').style.display = isRegister ? 'block' : 'none';
    document.getElementById('auth-btn').innerText = isRegister ? 'Cadastrar' : 'Entrar';
    document.getElementById('auth-form').dataset.mode = mode;
    
    // Atualiza estilo dos botões
    const tabs = document.querySelectorAll('.auth-tabs button');
    tabs.forEach(t => t.classList.remove('active'));
    // Encontra o botão clicado (hack simples)
    if(event && event.target) event.target.classList.add('active');
};

window.toggleHistory = () => {
    const p = document.getElementById('history-panel');
    p.classList.toggle('hidden');
};

// --- TELA DE LOADING ---
function hideLoading() {
    const screen = document.getElementById('loading-screen');
    if(screen) screen.style.display = 'none';
}

// --- AUTENTICAÇÃO E INICIALIZAÇÃO ---
onAuthStateChanged(auth, (user) => {
    hideLoading(); // Remove a tela de loading assim que o Firebase responder
    
    if (user) {
        log("Usuário logado: " + user.uid);
        window.navTo('dashboard');
        
        onSnapshot(doc(db, "users", user.uid), (docSnap) => {
            if (docSnap.exists()) {
                currentUserData = docSnap.data();
                currentUserData.uid = user.uid;
                
                // Atualiza UI
                safeSetText('user-name', currentUserData.name);
                safeSetText('user-role', currentUserData.role === 'merchant' ? 'Vendedor' : 'Usuário');
                safeSetText('user-balance', `R$ ${currentUserData.balance.toFixed(2)}`);
                safeSetText('user-short-id', currentUserData.shortId || "...");
                
                const avatar = document.getElementById('user-avatar');
                if(avatar) avatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUserData.name)}&background=random`;

                // Admin
                const adminBtn = document.getElementById('admin-btn');
                if (currentUserData.role === 'admin') {
                    if(adminBtn) adminBtn.classList.remove('hidden');
                    loadAdminData();
                } else {
                    if(adminBtn) adminBtn.classList.add('hidden');
                }
            } else {
                log("Documento do usuário não existe no Firestore!");
            }
        });

        listenToTransactions(user.uid);
        syncTaxRate();

    } else {
        log("Nenhum usuário logado.");
        window.navTo('auth');
    }
});

// Helper para evitar erros se o elemento não existir
function safeSetText(id, text) {
    const el = document.getElementById(id);
    if(el) el.innerText = text;
}

// --- LOGOUT ---
const logoutBtn = document.getElementById('logout-btn');
if(logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        signOut(auth).then(() => {
            window.navTo('auth');
            log("Logout realizado.");
        });
    });
}

// --- LOGIN / REGISTRO ---
const authForm = document.getElementById('auth-form');
if(authForm) {
    authForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const mode = authForm.dataset.mode || 'login';
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const btn = document.getElementById('auth-btn');
        
        btn.innerText = "Aguarde...";
        btn.disabled = true;

        try {
            if (mode === 'register') {
                const name = document.getElementById('fullname').value;
                const role = document.getElementById('role-select').value;
                const shortId = generateShortId();
                
                const userCred = await createUserWithEmailAndPassword(auth, email, password);
                await setDoc(doc(db, "users", userCred.user.uid), {
                    name: name, email: email, role: role, shortId: shortId,
                    balance: 1000.00, createdAt: serverTimestamp()
                });
                showToast("Cadastrado com sucesso!");
            } else {
                await signInWithEmailAndPassword(auth, email, password);
            }
        } catch (error) {
            console.error(error);
            showToast("Erro: " + error.message, 'error');
            btn.innerText = mode === 'register' ? 'Cadastrar' : 'Entrar';
            btn.disabled = false;
        }
    });
}

// --- UTILITÁRIOS ---
function generateShortId() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for(let i=0; i<6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

const showToast = (msg, type = 'success') => {
    const container = document.getElementById('toast-container');
    if(!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = msg;
    // Estilo básico inline para garantir que apareça
    toast.style.background = type === 'error' ? 'red' : 'green';
    toast.style.color = 'white';
    toast.style.padding = '10px';
    toast.style.margin = '10px';
    toast.style.borderRadius = '5px';
    
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
};

// --- QR CODE E TRANSAÇÕES (Simplificado para estabilidade) ---
window.generateQR = () => {
    const amt = document.getElementById('qr-amount').value;
    const img = document.getElementById('qr-image');
    if(amt > 0 && currentUserData) {
        const payload = JSON.stringify({ sid: currentUserData.shortId, amt: parseFloat(amt) });
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(payload)}`;
        img.style.display = 'block';
    } else {
        img.style.display = 'none';
    }
};

window.resetScanner = () => {
    document.getElementById('scan-result').classList.add('hidden');
    startScanner();
};

function startScanner() {
    if(html5QrcodeScanner) return; // Já está rodando
    
    // Verifica se a lib carregou
    if(typeof Html5Qrcode === "undefined") {
        showToast("Erro: Biblioteca de Câmera não carregou.", "error");
        return;
    }

    try {
        html5QrcodeScanner = new Html5Qrcode("reader");
        html5QrcodeScanner.start(
            { facingMode: "environment" }, 
            { fps: 10, qrbox: 250 },
            async (decodedText) => {
                try {
                    const data = JSON.parse(decodedText);
                    if(data.sid && data.amt) {
                        stopScanner();
                        handleScanResult(data);
                    }
                } catch(e) { /* Lendo frames inválidos... ignora */ }
            },
            (errorMessage) => {}
        );
    } catch(err) {
        console.error("Erro Câmera:", err);
        showToast("Erro ao abrir câmera. Use HTTPS.", "error");
    }
}

function stopScanner() {
    if(html5QrcodeScanner) {
        html5QrcodeScanner.stop().then(() => {
            html5QrcodeScanner.clear();
            html5QrcodeScanner = null;
        }).catch(err => console.log("Erro ao parar scanner", err));
    }
}

async function handleScanResult(data) {
    const rData = await getUidFromShortId(data.sid);
    if(rData) {
        document.getElementById('scan-result').classList.remove('hidden');
        document.getElementById('scan-amt').innerText = data.amt;
        document.getElementById('scan-to-name').innerText = rData.data.name;
        
        const btn = document.getElementById('confirm-pay-btn');
        // Clonar para limpar eventos antigos
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        
        newBtn.addEventListener('click', () => {
            newBtn.disabled = true;
            newBtn.innerText = "Enviando...";
            processTransaction(data.sid, data.amt).then(() => {
                newBtn.disabled = false;
                newBtn.innerText = "Confirmar Pagamento";
            });
        });
    } else {
        showToast("Usuário não encontrado!");
        setTimeout(startScanner, 2000);
    }
}

// --- FUNÇÕES DE SUPORTE (TRANSAÇÃO / ADMIN) ---
// (Reutilizando lógica, mas garantindo que estejam definidas)

async function getUidFromShortId(shortId) {
    const q = query(collection(db, "users"), where("shortId", "==", shortId));
    const snapshot = await getDocs(q);
    return snapshot.empty ? null : { uid: snapshot.docs[0].id, data: snapshot.docs[0].data() };
}

async function processTransaction(receiverShortId, amount) {
    try {
        const receiverInfo = await getUidFromShortId(receiverShortId);
        if(!receiverInfo) throw new Error("Destinatário inválido");
        
        const tax = amount * currentTaxRate;
        const total = amount + tax;
        
        await runTransaction(db, async (t) => {
            const senderRef = doc(db, "users", currentUserData.uid);
            const sDoc = await t.get(senderRef);
            if(sDoc.data().balance < total) throw "Saldo insuficiente";
            
            const rRef = doc(db, "users", receiverInfo.uid);
            const rDoc = await t.get(rRef);
            
            t.update(senderRef, { balance: sDoc.data().balance - total });
            t.update(rRef, { balance: rDoc.data().balance + amount });
            
            // Taxa prefeitura
            if(CITY_HALL_ID.length > 5) {
                const cRef = doc(db, "users", CITY_HALL_ID);
                const cDoc = await t.get(cRef);
                if(cDoc.exists()) t.update(cRef, { balance: cDoc.data().balance + tax });
            }

            // Histórico
            const txRef = doc(collection(db, "transactions"));
            t.set(txRef, {
                participants: [currentUserData.uid, receiverInfo.uid],
                amount: amount,
                timestamp: serverTimestamp(),
                senderId: currentUserData.uid,
                receiverId: receiverInfo.uid
            });
        });
        
        showToast("Transferência com Sucesso!");
        window.navTo('dashboard');
        
    } catch(e) {
        showToast("Erro: " + (e.message || e), "error");
    }
}

window.updateTaxRate = async () => {
    // Implementação básica
    const val = parseFloat(document.getElementById('new-tax-rate').value) / 100;
    if(CITY_HALL_ID) {
        try {
            await updateDoc(doc(db, "users", CITY_HALL_ID), { customTax: val });
            showToast("Taxa atualizada");
        } catch(e) { showToast("Erro admin", "error"); }
    }
};

function syncTaxRate() {
    if(CITY_HALL_ID.length > 5) {
        onSnapshot(doc(db, "users", CITY_HALL_ID), (s) => {
            if(s.exists()) {
                currentTaxRate = s.data().customTax || 0.02;
                safeSetText('current-tax-display', (currentTaxRate*100).toFixed(1));
            }
        });
    }
}

function loadAdminData() {
    // Lógica admin simplificada para não travar load inicial
}

function listenToTransactions(uid) {
    const q = query(collection(db, "transactions"), where("participants", "array-contains", uid), limit(10));
    onSnapshot(q, (snap) => {
        const list = document.getElementById('transaction-list');
        if(!list) return;
        list.innerHTML = "";
        snap.forEach(d => {
            const t = d.data();
            const isSend = t.senderId === uid;
            const li = document.createElement('li');
            li.style.cssText = "border-bottom: 1px solid #444; padding: 8px; display: flex; justify-content: space-between;";
            li.innerHTML = `<span>${isSend ? 'Enviou' : 'Recebeu'}</span> <span style="color:${isSend?'#ff4444':'#00C851'}">${isSend?'-':'+'} R$ ${t.amount}</span>`;
            list.appendChild(li);
        });
    });
}