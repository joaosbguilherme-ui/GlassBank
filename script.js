import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, updateDoc, collection, query, where, onSnapshot, runTransaction, serverTimestamp, orderBy, limit, getDocs } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js";

// --- CONFIGURAÇÃO FIREBASE ---
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
let currentUser = null;
let currentTaxRate = 0.02; 
let html5QrcodeScanner = null;
let pendingTransaction = null; 

// =========================================================
// ⚠️ CERTIFIQUE-SE QUE O UID DA PREFEITURA ESTÁ CORRETO AQUI
const CITY_HALL_ID = "COLE_O_UID_DA_PREFEITURA_AQUI"; 
// =========================================================

// --- SONS ---
const playSound = (type) => {
    const id = type === 'success' ? 'snd-success' : type === 'error' ? 'snd-error' : 'snd-click';
    const audio = document.getElementById(id);
    if(audio) { audio.currentTime = 0; audio.play().catch(e => {}); }
};

// --- UI HELPERS ---
const showToast = (msg, type = 'success') => {
    playSound(type);
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerText = msg;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
};

window.navTo = (sectionId) => {
    playSound('click');
    document.querySelectorAll('section').forEach(s => s.classList.remove('active-section'));
    document.querySelectorAll('section').forEach(s => s.classList.add('hidden'));
    
    const target = document.getElementById(sectionId + '-section');
    if(target) {
        target.classList.remove('hidden');
        target.classList.add('active-section');
    }
    
    if(sectionId === 'qr-scan') startScanner();
    else stopScanner();
};

window.closeModal = (id) => {
    document.getElementById(id).classList.add('hidden');
    pendingTransaction = null; 
};

window.toggleAuth = (mode) => {
    const isReg = mode === 'register';
    document.getElementById('fullname').style.display = isReg ? 'block' : 'none';
    document.getElementById('role-select').style.display = isReg ? 'block' : 'none';
    document.getElementById('reg-pin').style.display = isReg ? 'block' : 'none';
    document.getElementById('auth-btn').innerText = isReg ? 'Cadastrar' : 'Entrar';
    document.getElementById('auth-form').dataset.mode = mode;
};

// --- SISTEMA DE ID ---
function generateShortId() {
    const chars = "ABCDEF0123456789";
    let res = "";
    for(let i=0; i<6; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
    return res;
}

// --- AUTENTICAÇÃO ---
const authForm = document.getElementById('auth-form');
authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('auth-btn');
    const originalText = btn.innerText;
    btn.innerText = "Processando...";
    btn.disabled = true;

    const mode = authForm.dataset.mode || 'login';
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    
    try {
        if (mode === 'register') {
            const name = document.getElementById('fullname').value;
            const role = document.getElementById('role-select').value;
            const pin = document.getElementById('reg-pin').value;
            
            if(pin.length !== 4) throw new Error("PIN deve ter 4 números.");

            const userCred = await createUserWithEmailAndPassword(auth, email, password);
            
            await setDoc(doc(db, "users", userCred.user.uid), {
                name: name, email: email, role: role, pin: pin,
                shortId: generateShortId(),
                balance: 1000.00,
                status: 'active',
                lastInterestDate: serverTimestamp(),
                createdAt: serverTimestamp()
            });
            showToast("Conta criada com sucesso!");
        } else {
            await signInWithEmailAndPassword(auth, email, password);
        }
    } catch (err) {
        showToast(err.message, 'error');
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
});

onAuthStateChanged(auth, (user) => {
    if (user) {
        document.getElementById('auth-section').classList.remove('active-section');
        navTo('dashboard');
        initializeUser(user.uid);
    } else {
        navTo('auth');
        document.getElementById('auth-section').classList.add('active-section');
        currentUser = null;
    }
});

document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));

// --- LÓGICA DO USUÁRIO ---
function initializeUser(uid) {
    onSnapshot(doc(db, "users", uid), (docSnap) => {
        if (docSnap.exists()) {
            currentUser = docSnap.data();
            currentUser.uid = uid;

            if(currentUser.status === 'banned') {
                alert("Conta suspensa.");
                signOut(auth);
                return;
            }

            document.getElementById('user-name').innerText = currentUser.name;
            document.getElementById('user-role').innerText = currentUser.role === 'admin' ? 'Prefeitura' : 'Cidadão';
            document.getElementById('user-balance').innerText = `R$ ${currentUser.balance.toFixed(2)}`;
            document.getElementById('user-short-id').innerText = currentUser.shortId;
            document.getElementById('user-avatar').src = `https://ui-avatars.com/api/?name=${currentUser.name}&background=random&color=fff`;

            const loanBadge = document.getElementById('loan-indicator');
            loanBadge.style.display = currentUser.balance < 0 ? 'inline-block' : 'none';

            if(currentUser.role === 'admin') {
                document.getElementById('admin-btn').classList.remove('hidden');
                initAdminPanel();
            }
        }
    });

    listenToTransactions(uid);
    syncGlobalTax();
}

// --- EMPRÉSTIMOS ---
window.takeLoan = async () => {
    const amount = parseFloat(document.getElementById('loan-amount-input').value);
    const limit = 5000; 
    
    if(!amount || amount <= 0) return showToast("Valor inválido", "error");
    if((currentUser.balance + amount) > limit) return showToast("Limite excedido", "error");

    try {
        await updateDoc(doc(db, "users", currentUser.uid), {
            balance: currentUser.balance + amount
        });
        
        await setDoc(doc(collection(db, "transactions")), {
            type: 'loan', userId: currentUser.uid, amount: amount, timestamp: serverTimestamp()
        });

        showToast(`Empréstimo recebido!`);
        navTo('dashboard');
    } catch(e) { showToast("Erro ao pegar empréstimo", "error"); }
};

// --- PREFEITURA ---
function syncGlobalTax() {
    if(CITY_HALL_ID.length > 5) {
        onSnapshot(doc(db, "users", CITY_HALL_ID), (snap) => {
            if(snap.exists()) {
                currentTaxRate = snap.data().customTax || 0.02;
                document.getElementById('tax-display').innerText = (currentTaxRate*100).toFixed(1) + "%";
                document.getElementById('city-hall-balance').innerText = `R$ ${snap.data().balance.toFixed(2)}`;
            }
        });
    }
}

function initAdminPanel() {
    // Funções extras de admin
}

window.banUser = async () => {
    const shortId = document.getElementById('ban-user-id').value;
    if(!shortId) return;
    const q = query(collection(db, "users"), where("shortId", "==", shortId));
    const snap = await getDocs(q);
    
    if(snap.empty) return showToast("Usuário não encontrado", "error");
    
    const targetUid = snap.docs[0].id;
    await updateDoc(doc(db, "users", targetUid), { status: "banned" });
    showToast("Usuário BANIDO.");
};

// --- TRANSAÇÃO (CORRIGIDA - LÓGICA DE LEITURA ANTES DA ESCRITA) ---

// 1. Botão Transferir (Com Verificações Robustas)
const transferForm = document.getElementById('transfer-form');
transferForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const submitBtn = transferForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerText;
    submitBtn.innerText = "Verificando...";
    submitBtn.disabled = true;

    const destId = document.getElementById('dest-id').value.toUpperCase();
    const amount = parseFloat(document.getElementById('amount').value);

    try {
        if(amount <= 0) throw new Error("Valor inválido");

        // Verificação de Limite (Try/Catch para não travar se o índice faltar)
        try {
            const recentTotal = await checkTransactionLimit(currentUser.uid);
            if(recentTotal + amount > 30000) {
                document.getElementById('limit-warning').classList.remove('hidden');
                throw new Error("Limite de R$ 30.000 / 15min excedido!");
            }
        } catch (limitErr) {
            if(limitErr.message.includes("Limite")) throw limitErr;
            console.warn("Aviso: Pulei a verificação de limite (falta índice ou erro de rede).");
        }

        // Se passou, armazena e pede PIN
        pendingTransaction = { destId, amount };
        document.getElementById('pin-modal').classList.remove('hidden');
        document.getElementById('confirm-pin-input').value = "";
        document.getElementById('confirm-pin-input').focus();

    } catch (err) {
        showToast(err.message, "error");
    } finally {
        submitBtn.innerText = originalText;
        submitBtn.disabled = false;
    }
});

// 2. Confirmação de PIN
document.getElementById('confirm-pin-btn').addEventListener('click', async () => {
    const inputPin = document.getElementById('confirm-pin-input').value;
    const btn = document.getElementById('confirm-pin-btn');
    
    if(inputPin !== currentUser.pin) {
        playSound('error');
        return showToast("PIN Incorreto!", "error");
    }

    btn.innerText = "Enviando...";
    btn.disabled = true;

    await executeTransaction(pendingTransaction.destId, pendingTransaction.amount);
    
    btn.innerText = "Confirmar";
    btn.disabled = false;
    closeModal('pin-modal');
});

// 3. Execução no DB (CORRIGIDO AQUI)
async function executeTransaction(shortId, amount) {
    try {
        // Primeiro: Buscamos QUEM vai receber para ter o UID
        const q = query(collection(db, "users"), where("shortId", "==", shortId));
        const receiverSnap = await getDocs(q);
        
        if(receiverSnap.empty) throw new Error("ID do destinatário não existe.");
        
        const receiverDoc = receiverSnap.docs[0];
        const receiverUid = receiverDoc.id;
        
        if(receiverUid === currentUser.uid) throw new Error("Você não pode enviar para si mesmo.");

        const tax = amount * currentTaxRate;
        const totalDed = amount + tax;

        // Inicia Transação Segura
        await runTransaction(db, async (transaction) => {
            // ==========================================
            // PASSO 1: LER TUDO (LEITURAS OBRIGATÓRIAS ANTES)
            // ==========================================
            const senderRef = doc(db, "users", currentUser.uid);
            const receiverRef = doc(db, "users", receiverUid);
            const cityRef = doc(db, "users", CITY_HALL_ID);

            const sDoc = await transaction.get(senderRef);
            const rDoc = await transaction.get(receiverRef);
            const cDoc = await transaction.get(cityRef);

            // ==========================================
            // PASSO 2: VALIDAR REGRAS COM O QUE FOI LIDO
            // ==========================================
            if (!sDoc.exists()) throw "Remetente não encontrado.";
            if (!rDoc.exists()) throw "Destinatário não encontrado no momento da transação.";
            
            const currentBalance = sDoc.data().balance;
            if (currentBalance < totalDed) throw "Saldo insuficiente (Valor + Taxa).";

            // ==========================================
            // PASSO 3: GRAVAR TUDO (ESCRITAS)
            // ==========================================
            
            // Debita Remetente
            transaction.update(senderRef, { balance: currentBalance - totalDed });
            
            // Credita Destinatário
            transaction.update(receiverRef, { balance: rDoc.data().balance + amount });
            
            // Credita Prefeitura (Só se a conta existir)
            if (cDoc.exists()) {
                transaction.update(cityRef, { balance: cDoc.data().balance + tax });
            }
            
            // Cria o Comprovante (Extrato)
            const txRef = doc(collection(db, "transactions"));
            transaction.set(txRef, {
                senderId: currentUser.uid,
                senderName: currentUser.name,
                receiverId: receiverUid,
                receiverName: rDoc.data().name,
                amount: amount,
                tax: tax,
                timestamp: serverTimestamp(),
                participants: [currentUser.uid, receiverUid]
            });
        });

        // Se chegou aqui, funcionou!
        showToast("Transferência Realizada!", "success");
        navTo('dashboard');
        document.getElementById('transfer-form').reset();

    } catch(e) {
        console.error("Erro Transação:", e);
        let msg = e.message || e;
        if(typeof msg !== 'string') msg = "Erro desconhecido na transação.";
        showToast(msg, "error");
    }
}

// 4. Checagem de Limite
async function checkTransactionLimit(uid) {
    // Se o índice não existir, isso vai falhar, mas o Try/Catch lá em cima garante que o app não pare.
    const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
    const q = query(
        collection(db, "transactions"),
        where("senderId", "==", uid),
        where("timestamp", ">", fifteenMinsAgo)
    );
    
    const snap = await getDocs(q);
    let total = 0;
    snap.forEach(d => total += d.data().amount);
    return total;
}

// --- HISTÓRICO E COMPROVANTE ---
function listenToTransactions(uid) {
    const q = query(
        collection(db, "transactions"), 
        where("participants", "array-contains", uid),
        orderBy("timestamp", "desc"),
        limit(20)
    );

    // Listener para atualizar a lista em tempo real
    onSnapshot(q, (snap) => {
        const list = document.getElementById('transaction-list');
        list.innerHTML = "";
        snap.forEach(docSnap => {
            const t = docSnap.data();
            const isSender = t.senderId === uid;
            
            const li = document.createElement('li');
            li.innerHTML = `
                <div>
                    <strong>${isSender ? 'Enviou para' : 'Recebeu de'} ${isSender ? t.receiverName : t.senderName}</strong><br>
                    <small>${t.timestamp ? t.timestamp.toDate().toLocaleDateString() : 'Agora'}</small>
                </div>
                <div style="color:${isSender ? '#ff416c' : '#00f260'}">
                    ${isSender ? '-' : '+'} R$ ${t.amount.toFixed(2)}
                </div>
            `;
            li.onclick = () => showReceipt(t, docSnap.id);
            list.appendChild(li);
        });
    }, (error) => {
        // Loga erro de índice se acontecer aqui também
        console.log("Erro no histórico (provável falta de índice):", error);
    });
}

function showReceipt(data, id) {
    document.getElementById('receipt-modal').classList.remove('hidden');
    document.getElementById('rcpt-amount').innerText = `R$ ${data.amount.toFixed(2)}`;
    document.getElementById('rcpt-date').innerText = data.timestamp ? data.timestamp.toDate().toLocaleString() : "...";
    document.getElementById('rcpt-sender').innerText = data.senderName;
    document.getElementById('rcpt-receiver').innerText = data.receiverName;
    document.getElementById('rcpt-id').innerText = id;
}

// --- QR CODE (SCANNER E GERADOR) ---
window.generateQR = () => {
    const amt = document.getElementById('qr-amount').value;
    const img = document.getElementById('qr-image');
    const ph = document.getElementById('qr-placeholder');
    if(!amt) { img.style.display = 'none'; ph.style.display = 'block'; return; }
    const payload = JSON.stringify({ sid: currentUser.shortId, amt: parseFloat(amt) });
    img.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(payload)}`;
    img.style.display = 'block'; ph.style.display = 'none';
};

function startScanner() {
    html5QrcodeScanner = new Html5Qrcode("reader");
    html5QrcodeScanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 },
        async (decodedText) => {
            try {
                const data = JSON.parse(decodedText);
                if(data.sid && data.amt) {
                    stopScanner();
                    playSound('success');
                    const q = query(collection(db, "users"), where("shortId", "==", data.sid));
                    const snap = await getDocs(q);
                    const name = snap.empty ? "Desconhecido" : snap.docs[0].data().name;
                    document.getElementById('scan-result').classList.remove('hidden');
                    document.getElementById('scan-amt').innerText = data.amt;
                    document.getElementById('scan-to-name').innerText = name;
                    document.getElementById('scan-pay-btn').onclick = () => {
                        document.getElementById('scan-result').classList.add('hidden');
                        pendingTransaction = { destId: data.sid, amount: parseFloat(data.amt) };
                        document.getElementById('pin-modal').classList.remove('hidden');
                    };
                }
            } catch(e) {}
        }
    ).catch(e => showToast("Erro Câmera", "error"));
}

function stopScanner() {
    if(html5QrcodeScanner) html5QrcodeScanner.stop().then(() => html5QrcodeScanner.clear()).catch(()=>{});
}
window.resetScanner = () => { document.getElementById('scan-result').classList.add('hidden'); startScanner(); };