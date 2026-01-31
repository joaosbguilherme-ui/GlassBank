// Importações
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, query, where, onSnapshot, runTransaction, serverTimestamp, orderBy, limit, getDocs } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

// --- CONFIGURAÇÃO ---
const firebaseConfig = {
  apiKey: "AIzaSyBkl7Vt5WHMoiU3mThXiG7hAzv1T0FvSRI",
  authDomain: "glassbank-c411b.firebaseapp.com",
  projectId: "glassbank-c411b",
  storageBucket: "glassbank-c411b.firebasestorage.app",
  messagingSenderId: "222854977565",
  appId: "1:222854977565:web:c654f9a0dbf47665f7cef4"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// --- ESTADO GLOBAL ---
let currentUserData = null;
let html5QrcodeScanner = null;

// ======================================================
// ⚠️ COLOQUE AQUI O ID (UID) REAL DA CONTA DA PREFEITURA
// Pegue no Firebase > Firestore > users
const CITY_HALL_ID = "COLE_O_ID_DA_PREFEITURA_AQUI"; 
// ======================================================

const TAX_RATE = 0.02;

// --- FUNÇÃO GERADORA DE ID (2 Digitos, 1 Letra, 2 Digitos, 1 Letra) ---
function generateShortId() {
    const n = () => Math.floor(Math.random() * 10);
    const l = () => "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 26)];
    return `${n()}${n()}${l()}${n()}${n()}${l()}`;
}

// --- UI HELPERS ---
const vibrate = () => { if(navigator.vibrate) navigator.vibrate(30); }

const showToast = (msg, type = 'success') => {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
};

window.navTo = (sectionId) => {
    document.querySelectorAll('section').forEach(s => s.classList.remove('active-section'));
    document.querySelectorAll('section').forEach(s => s.classList.add('hidden'));
    
    const target = document.getElementById(sectionId + (sectionId.includes('-section') ? '' : '-section'));
    if(target) {
        target.classList.remove('hidden');
        target.classList.add('active-section');
    }
    vibrate();
    
    if(sectionId === 'qr-scan') startScanner();
    else stopScanner();
};

window.toggleAuth = (mode) => {
    const isRegister = mode === 'register';
    document.getElementById('fullname').style.display = isRegister ? 'block' : 'none';
    document.getElementById('role-select').style.display = isRegister ? 'block' : 'none';
    document.getElementById('auth-btn').innerText = isRegister ? 'Cadastrar' : 'Entrar';
    document.getElementById('auth-form').dataset.mode = mode;
    document.querySelectorAll('.auth-tabs button').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
};

window.toggleHistory = () => {
    document.getElementById('history-panel').classList.toggle('hidden');
};

// --- AUTENTICAÇÃO ---
const authForm = document.getElementById('auth-form');
authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = authForm.dataset.mode || 'login';
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    
    try {
        if (mode === 'register') {
            const name = document.getElementById('fullname').value;
            const role = document.getElementById('role-select').value;
            const newShortId = generateShortId(); // Gera ID Curto
            
            const userCred = await createUserWithEmailAndPassword(auth, email, password);
            
            await setDoc(doc(db, "users", userCred.user.uid), {
                name: name,
                email: email,
                role: role,
                shortId: newShortId, // Salva o ID curto
                balance: 1000.00,
                createdAt: serverTimestamp()
            });
            showToast("Conta criada! ID: " + newShortId);
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (error) {
        showToast(error.message, 'error');
    }
});

onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('auth-section').classList.remove('active-section');
        navTo('dashboard');
        loadUserData(user.uid);
        listenToTransactions(user.uid);
    } else {
        navTo('auth');
        currentUserData = null;
    }
});

document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));

// --- DADOS DO USUÁRIO ---

// --- Banimento ---

if (currentUserData.status === 'banned') {
    alert("Sua conta foi suspensa por violação das regras.");
    signOut(auth);
}

function loadUserData(uid) {
    onSnapshot(doc(db, "users", uid), async (docSnap) => {
        if (docSnap.exists()) {
            currentUserData = docSnap.data();
            currentUserData.uid = uid;
            
            // Correção automática para usuários antigos sem ShortID
            if (!currentUserData.shortId) {
                const newId = generateShortId();
                await updateDoc(doc(db, "users", uid), { shortId: newId });
                return; // O snapshot vai rodar de novo automaticamente
            }

            document.getElementById('user-name').innerText = currentUserData.name;
            document.getElementById('user-role').innerText = currentUserData.role === 'merchant' ? 'Vendedor' : 'Usuário';
            document.getElementById('user-balance').innerText = `R$ ${currentUserData.balance.toFixed(2)}`;
            
            // Exibe o ID Curto (Visual)
            document.getElementById('user-short-id').innerText = currentUserData.shortId;
            document.getElementById('user-avatar').src = `https://ui-avatars.com/api/?name=${currentUserData.name}&background=random`;

            // Verifica se é Admin
            if (currentUserData.role === 'admin') {
                document.getElementById('admin-btn').classList.remove('hidden');
                loadAdminData();
            }
        }
    });
}

// --- PAINEL ADMIN ---
function loadAdminData() {
    // Saldo da Prefeitura
    onSnapshot(doc(db, "users", CITY_HALL_ID), (docSnap) => {
        if(docSnap.exists()) {
            document.getElementById('city-hall-balance').innerText = `R$ ${docSnap.data().balance.toFixed(2)}`;
        }
    });

    // Lista de Usuários
    const q = query(collection(db, "users"), limit(5));
    onSnapshot(q, (snap) => {
        const list = document.getElementById('admin-user-list');
        list.innerHTML = "";
        snap.forEach(d => {
            const u = d.data();
            list.innerHTML += `<li style="padding:5px; border-bottom:1px solid #ffffff20; display:flex; justify-content:space-between;">
                <span>${u.name} <small>(${u.shortId || 'ANTIGO'})</small></span>
                <span>R$ ${u.balance.toFixed(2)}</span>
            </li>`;
        });
    });
}

function listenToTransactions(uid) {
    const q = query(
        collection(db, "transactions"), 
        where("participants", "array-contains", uid),
        orderBy("timestamp", "desc"),
        limit(20)
    );

    onSnapshot(q, (snapshot) => {
        const list = document.getElementById('transaction-list');
        list.innerHTML = "";
        snapshot.forEach(doc => {
            const data = doc.data();
            const isSender = data.senderId === uid;
            const li = document.createElement('li');
            li.style.cssText = "display:flex; justify-content:space-between; padding:10px; border-bottom:1px solid rgba(255,255,255,0.1);";
            li.innerHTML = `
                <span>${isSender ? 'Para: ' + data.receiverName : 'De: ' + data.senderName}</span>
                <span style="color: ${isSender ? '#ff7675' : '#55efc4'}">
                    ${isSender ? '-' : '+'} R$ ${data.amount.toFixed(2)}
                </span>
            `;
            list.appendChild(li);
        });
    });
}

// --- RESOLUÇÃO DE ID (Short ID -> Real UID) ---
async function getUidFromShortId(shortId) {
    const q = query(collection(db, "users"), where("shortId", "==", shortId));
    const snapshot = await getDocs(q);
    if (snapshot.empty) return null;
    return { uid: snapshot.docs[0].id, data: snapshot.docs[0].data() };
}

// --- TRANSAÇÃO ---
async function processTransaction(receiverShortId, amount) {
    if (!currentUserData) return;
    if (amount <= 0) return showToast("Valor inválido", "error");

    try {
        // 1. Achar o UID real baseado no ID Curto
        const receiverData = await getUidFromShortId(receiverShortId);
        
        if (!receiverData) throw "ID do destinatário não encontrado!";
        if (receiverData.uid === currentUserData.uid) throw "Não pode enviar para si mesmo";

        const senderRef = doc(db, "users", currentUserData.uid);
        const receiverRef = doc(db, "users", receiverData.uid);
        const cityHallRef = doc(db, "users", CITY_HALL_ID);

        const tax = amount * TAX_RATE;
        const totalDeduction = amount + tax;

        await runTransaction(db, async (transaction) => {
            const senderDoc = await transaction.get(senderRef);
            if (!senderDoc.exists()) throw "Erro no remetente";

            const senderBalance = senderDoc.data().balance;
            if (senderBalance < totalDeduction) throw "Saldo insuficiente (Valor + Taxa)";
            
            const receiverDoc = await transaction.get(receiverRef); // Garante leitura atualizada

            // Debita User
            transaction.update(senderRef, { balance: senderBalance - totalDeduction });
            // Crédita Destino
            transaction.update(receiverRef, { balance: receiverDoc.data().balance + amount });
            
            // Crédita Prefeitura (Se existir conta configurada)
            const cityHallDoc = await transaction.get(cityHallRef);
            if (cityHallDoc.exists()) {
                transaction.update(cityHallRef, { balance: cityHallDoc.data().balance + tax });
            }

            // Extrato
            const txRef = doc(collection(db, "transactions"));
            transaction.set(txRef, {
                senderId: currentUserData.uid,
                senderName: currentUserData.name,
                receiverId: receiverData.uid,
                receiverName: receiverData.data.name,
                amount: amount,
                tax: tax,
                participants: [currentUserData.uid, receiverData.uid],
                timestamp: serverTimestamp()
            });
        });
        
        showToast("Transferência com Sucesso!");
        navTo('dashboard');
    } catch (e) {
        console.error(e);
        showToast(e, "error");
    }
}

// Transferência Manual
document.getElementById('transfer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const shortId = document.getElementById('dest-id').value.toUpperCase();
    const amt = parseFloat(document.getElementById('amount').value);
    processTransaction(shortId, amt);
});

// Calculadora
document.getElementById('amount').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value) || 0;
    document.getElementById('tax-calc').innerText = `R$ ${(val * TAX_RATE).toFixed(2)}`;
});

// --- QR CODE ---

// Gerar QR (Agora com Short ID)
window.generateQR = () => {
    const amt = document.getElementById('qr-amount').value;
    const container = document.getElementById('qrcode-container');
    container.innerHTML = "";
    
    if(!amt || amt <= 0) return;

    // Payload agora usa o Short ID para facilitar leitura humana se precisar
    const payload = JSON.stringify({
        sid: currentUserData.shortId, 
        amt: parseFloat(amt)
    });

    new QRCode(container, { text: payload, width: 180, height: 180 });
};

// Scanner
function startScanner() {
    html5QrcodeScanner = new Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" }, 
        { fps: 10, qrbox: 250 },
        async (decodedText) => {
            try {
                const data = JSON.parse(decodedText);
                if(data.sid && data.amt) {
                    stopScanner();
                    
                    // Busca nome do dono do QR Code
                    const rData = await getUidFromShortId(data.sid);
                    
                    document.getElementById('scan-result').classList.remove('hidden');
                    document.getElementById('scan-amt').innerText = data.amt;
                    document.getElementById('scan-to-name').innerText = rData ? rData.data.name : "Desconhecido";
                    document.getElementById('scan-to-id').innerText = data.sid;
                    
                    document.getElementById('confirm-pay-btn').onclick = () => processTransaction(data.sid, data.amt);
                    vibrate();
                }
            } catch (e) { showToast("QR inválido", "error"); }
        },
        (errorMessage) => {}
    ).catch(() => showToast("Erro Câmera (Use HTTPS)", "error"));
}

function stopScanner() {
    if(html5QrcodeScanner) {
        html5QrcodeScanner.stop().then(() => html5QrcodeScanner.clear()).catch(()=>{});
    }
}

window.resetScanner = () => {
    document.getElementById('scan-result').classList.add('hidden');
    startScanner();
};