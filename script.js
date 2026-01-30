// Importações do Firebase SDK v9
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, query, where, onSnapshot, runTransaction, serverTimestamp, orderBy, limit } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

// --- CONFIGURAÇÃO DO FIREBASE ---
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
const CITY_HALL_ID = "PREFEITURA_ID_FIXO"; // ID fixo para conta do governo
const TAX_RATE = 0.02; // 2% de imposto

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

// Navegação SPA
window.navTo = (sectionId) => {
    document.querySelectorAll('section').forEach(s => s.classList.remove('active-section'));
    document.querySelectorAll('section').forEach(s => s.classList.add('hidden'));
    
    const target = document.getElementById(sectionId + '-section') || document.getElementById(sectionId);
    target.classList.remove('hidden');
    target.classList.add('active-section');
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
    // Highlight active tab
    document.querySelectorAll('.auth-tabs button').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
};

window.toggleHistory = () => {
    const panel = document.getElementById('history-panel');
    panel.classList.toggle('hidden');
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
            const userCred = await createUserWithEmailAndPassword(auth, email, password);
            
            // Criar documento do usuário no Firestore
            // Usamos o UID do Auth como ID do documento
            await setDoc(doc(db, "users", userCred.user.uid), {
                name: name,
                email: email,
                role: role,
                balance: 1000.00, // Bônus inicial
                createdAt: serverTimestamp()
            });
            showToast("Conta criada! Bem-vindo.");
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (error) {
        showToast(error.message, 'error');
    }
});

// Listener de estado de Auth
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

// --- DADOS DO USUÁRIO & DASHBOARD ---
function loadUserData(uid) {
    // Escuta em tempo real o documento do usuário
    onSnapshot(doc(db, "users", uid), (docSnap) => {
        if (docSnap.exists()) {
            currentUserData = docSnap.data();
            currentUserData.uid = uid;
            
            document.getElementById('user-name').innerText = currentUserData.name;
            document.getElementById('user-role').innerText = currentUserData.role === 'merchant' ? 'Vendedor' : 'Usuário';
            document.getElementById('user-balance').innerText = `R$ ${currentUserData.balance.toFixed(2)}`;
            document.getElementById('user-id').innerText = uid.substring(0, 8) + '...';
            
            // Avatar
            document.getElementById('user-avatar').src = `https://ui-avatars.com/api/?name=${currentUserData.name}&background=random`;
        }
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
            li.innerHTML = `
                <span>${isSender ? 'Enviou para ' + data.receiverName : 'Recebeu de ' + data.senderName}</span>
                <span class="${isSender ? 'tx-negative' : 'tx-positive'}">
                    ${isSender ? '-' : '+'} R$ ${data.amount.toFixed(2)}
                </span>
            `;
            list.appendChild(li);
        });
    });
}

// --- SISTEMA DE TRANSFERÊNCIA (Lógica Core) ---
async function processTransaction(receiverId, amount) {
    if (!currentUserData) return;
    if (amount <= 0) return showToast("Valor inválido", "error");
    if (receiverId === currentUserData.uid) return showToast("Não pode enviar para si mesmo", "error");

    const senderRef = doc(db, "users", currentUserData.uid);
    const receiverRef = doc(db, "users", receiverId);
    const cityHallRef = doc(db, "users", CITY_HALL_ID);

    const tax = amount * TAX_RATE;
    const totalDeduction = amount + tax;

    try {
        await runTransaction(db, async (transaction) => {
            const senderDoc = await transaction.get(senderRef);
            if (!senderDoc.exists()) throw "Remetente não encontrado";
            
            const receiverDoc = await transaction.get(receiverRef);
            if (!receiverDoc.exists()) throw "Destinatário não existe (Verifique o ID)";

            const senderBalance = senderDoc.data().balance;
            if (senderBalance < totalDeduction) throw "Saldo insuficiente (Valor + Taxa)";

            // Atualiza saldos
            transaction.update(senderRef, { balance: senderBalance - totalDeduction });
            transaction.update(receiverRef, { balance: receiverDoc.data().balance + amount });
            
            // Tenta depositar imposto (se prefeitura existir)
            const cityHallDoc = await transaction.get(cityHallRef);
            if (cityHallDoc.exists()) {
                transaction.update(cityHallRef, { balance: cityHallDoc.data().balance + tax });
            }

            // Registra transação
            const txRef = doc(collection(db, "transactions"));
            transaction.set(txRef, {
                senderId: currentUserData.uid,
                senderName: currentUserData.name,
                receiverId: receiverId,
                receiverName: receiverDoc.data().name,
                amount: amount,
                tax: tax,
                participants: [currentUserData.uid, receiverId],
                timestamp: serverTimestamp()
            });
        });
        
        showToast("Transferência realizada com sucesso!");
        navTo('dashboard');
        vibrate();
    } catch (e) {
        console.error(e);
        showToast("Erro: " + e, "error");
    }
}

// Handler do formulário manual
document.getElementById('transfer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const dest = document.getElementById('dest-id').value;
    const amt = parseFloat(document.getElementById('amount').value);
    processTransaction(dest, amt);
});

// Calculadora visual de taxa
document.getElementById('amount').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value) || 0;
    document.getElementById('tax-calc').innerText = `R$ ${(val * TAX_RATE).toFixed(2)}`;
});

// --- SISTEMA DE QR CODE ---

// 1. Gerador
window.generateQR = () => {
    const amt = document.getElementById('qr-amount').value;
    const container = document.getElementById('qrcode-container');
    container.innerHTML = ""; // Limpa anterior
    
    if(!amt || amt <= 0) return;

    const payload = JSON.stringify({
        to: currentUserData.uid,
        amt: parseFloat(amt),
        ts: Date.now()
    });

    new QRCode(container, {
        text: payload,
        width: 180,
        height: 180
    });
};

// 2. Scanner
function startScanner() {
    html5QrcodeScanner = new Html5Qrcode("reader");
    html5QrcodeScanner.start(
        { facingMode: "environment" }, 
        { fps: 10, qrbox: 250 },
        onScanSuccess,
        (errorMessage) => { /* ignora erros de leitura frame a frame */ }
    ).catch(err => {
        showToast("Erro na câmera: HTTPS necessário", "error");
    });
}

function stopScanner() {
    if(html5QrcodeScanner) {
        html5QrcodeScanner.stop().then(() => html5QrcodeScanner.clear());
    }
}

function onScanSuccess(decodedText, decodedResult) {
    try {
        const data = JSON.parse(decodedText);
        if(data.to && data.amt) {
            stopScanner(); // Para de ler
            document.getElementById('scan-result').classList.remove('hidden');
            document.getElementById('scan-amt').innerText = data.amt;
            document.getElementById('scan-to').innerText = data.to;
            
            // Configura botão de confirmação
            const btn = document.getElementById('confirm-pay-btn');
            btn.onclick = () => processTransaction(data.to, data.amt);
            vibrate();
        }
    } catch (e) {
        showToast("QR Code inválido", "error");
    }
}

window.resetScanner = () => {
    document.getElementById('scan-result').classList.add('hidden');
    startScanner();
};