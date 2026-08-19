let WHATSAPP_NUMBER = '6282123776363';
let siteSettings = {};
const money = n => new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(n||0);
let products=[];
let cart=JSON.parse(localStorage.getItem('belilas_premium_cart')||'[]');
let activeCategory='all'; let searchText=''; let checkoutStep=1; let lastOrderId='';
const $=id=>document.getElementById(id);
const overlay=$('overlay'),cartDrawer=$('cartDrawer'),checkoutModal=$('checkoutModal'),trackModal=$('trackModal'),successModal=$('successModal');

async function loadSettings(){
  const r=await fetch('/api/settings'); siteSettings=await r.json();
  WHATSAPP_NUMBER=siteSettings.whatsappNumber||WHATSAPP_NUMBER;
  const textMap={promoText:'promoText',heroEyebrow:'heroEyebrow',heroTitleBefore:'heroTitleBefore',heroHighlight:'heroHighlight',heroTitleAfter:'heroTitleAfter',heroText:'heroText',contactTitle:'contactTitle',contactText:'contactText',whatsappDisplay:'whatsappDisplay',storeHours:'storeHours',footerText:'footerText'};
  for(const [key,id] of Object.entries(textMap)){if($(id)&&siteSettings[key]!=null)$(id).textContent=siteSettings[key]}
  if($('footerWhatsapp'))$('footerWhatsapp').textContent=siteSettings.whatsappDisplay||'082123776363';
  if($('contactBrand'))$('contactBrand').textContent=siteSettings.siteName||'Belilas Digital Printing';
  document.querySelectorAll('.brand-logo').forEach(img=>img.src=siteSettings.logoUrl||'/belilas-logo.png');
  document.title=`${siteSettings.siteName||'Belilas Digital Printing'} — Cetak Mudah, Hasil Premium`;
}
async function loadProducts(){const res=await fetch('/api/products');products=(await res.json()).filter(p=>p.active!==false);renderProducts();renderCart()}
function accentStyle(a){const map={blue:['#dff6ff','#19b8e7'],yellow:['#fff2b8','#e8a900'],purple:['#eee8ff','#8166d9'],cyan:['#daf9ff','#0aa9d4'],pink:['#ffe1f0','#ed2493'],orange:['#ffe5d9','#f37141'],slate:['#e9eef4','#53647c']};return map[a]||map.blue}
function esc(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}
function renderProducts(){const list=products.filter(p=>(activeCategory==='all'||p.category===activeCategory)&&(`${p.name} ${p.description}`.toLowerCase().includes(searchText)));$('productGrid').innerHTML=list.map(p=>{const[bg,fg]=accentStyle(p.accent);return `<article class="product-card"><div class="product-visual" style="background:${bg};color:${fg}"><span class="product-badge">${esc(p.badge)}</span><div class="product-mock"><div class="mock-bar"></div><div class="mock-line"></div><div class="mock-line"></div><div class="mock-line short"></div></div></div><div class="product-body"><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><div class="product-bottom"><div class="product-price"><small>Mulai dari</small><strong>${money(p.price)} / ${esc(p.unit)}</strong></div><button class="add-btn" onclick="addToCart('${p.id}')">+</button></div></div></article>`}).join('')||'<p>Tidak ada produk yang cocok.</p>'}
function saveCart(){localStorage.setItem('belilas_premium_cart',JSON.stringify(cart));renderCart()}
function addToCart(id){const x=cart.find(i=>i.id===id);if(x)x.qty++;else cart.push({id,qty:1});saveCart();toast('Produk ditambahkan ke keranjang')}
function changeQty(id,d){const x=cart.find(i=>i.id===id);if(!x)return;x.qty+=d;if(x.qty<=0)cart=cart.filter(i=>i.id!==id);saveCart()}
function removeItem(id){cart=cart.filter(i=>i.id!==id);saveCart()}
function cartSubtotal(){return cart.reduce((s,i)=>{const p=products.find(x=>x.id===i.id);return s+(p?p.price*i.qty:0)},0)}
function renderCart(){$('cartCount').textContent=cart.reduce((s,i)=>s+i.qty,0);if(!cart.length){$('cartItems').innerHTML='';$('cartEmpty').style.display='block';$('cartSummary').style.display='none';return}$('cartEmpty').style.display='none';$('cartSummary').style.display='block';$('cartItems').innerHTML=cart.map(i=>{const p=products.find(x=>x.id===i.id);if(!p)return'';return `<div class="cart-item"><div><h4>${esc(p.name)}</h4><small>${money(p.price)} / ${esc(p.unit)}</small><div class="qty"><button onclick="changeQty('${p.id}',-1)">−</button><b>${i.qty}</b><button onclick="changeQty('${p.id}',1)">+</button></div></div><div class="cart-right"><strong>${money(p.price*i.qty)}</strong><br><button class="remove-btn" onclick="removeItem('${p.id}')">Hapus</button></div></div>`}).join('');$('cartTotal').textContent=money(cartSubtotal())}
function showOverlay(){overlay.classList.add('show');document.body.style.overflow='hidden'}function hideAll(){cartDrawer.classList.remove('open');checkoutModal.classList.remove('open');trackModal.classList.remove('open');successModal.classList.remove('open');overlay.classList.remove('show');document.body.style.overflow=''}function openCart(){cartDrawer.classList.add('open');showOverlay()}function openCheckout(){if(!cart.length){toast('Keranjang masih kosong');return}cartDrawer.classList.remove('open');checkoutModal.classList.add('open');checkoutStep=1;updateCheckoutStep();showOverlay()}function openTrack(){hideAll();trackModal.classList.add('open');showOverlay()}function setStep(n){checkoutStep=Math.max(1,Math.min(3,n));updateCheckoutStep()}function updateCheckoutStep(){document.querySelectorAll('.checkout-step').forEach(s=>s.classList.toggle('active',Number(s.dataset.step)===checkoutStep));document.querySelectorAll('[data-step-dot]').forEach(s=>s.classList.toggle('active',Number(s.dataset.stepDot)<=checkoutStep));$('prevStepBtn').style.visibility=checkoutStep===1?'hidden':'visible';$('nextStepBtn').style.display=checkoutStep===3?'none':'inline-flex';$('submitOrderBtn').style.display=checkoutStep===3?'inline-flex':'none';if(checkoutStep===3)renderCheckoutSummary()}function validateStep(){if(checkoutStep===1){const name=$('customerName').value.trim(),phone=$('customerPhone').value.replace(/\D/g,'');if(!name||phone.length<9){toast('Isi nama dan nomor WhatsApp terlebih dahulu');return false}}return true}function selectedShipping(){return document.querySelector('input[name="shipping"]:checked')?.value||'pickup'}function shippingFee(){return{pickup:0,local:15000,expedition:25000}[selectedShipping()]||0}function renderCheckoutSummary(){const sub=cartSubtotal(),ship=shippingFee();$('checkoutSummary').innerHTML=`<div class="summary-line"><span>Subtotal</span><strong>${money(sub)}</strong></div><div class="summary-line"><span>Estimasi pengiriman</span><strong>${money(ship)}</strong></div><div class="summary-line total"><span>Estimasi total</span><strong>${money(sub+ship)}</strong></div>`}
$('openCartBtn').addEventListener('click',openCart);$('closeCartBtn').addEventListener('click',hideAll);$('checkoutBtn').addEventListener('click',openCheckout);$('closeCheckoutBtn').addEventListener('click',hideAll);$('closeTrackBtn').addEventListener('click',hideAll);$('closeSuccessBtn').addEventListener('click',hideAll);overlay.addEventListener('click',hideAll);['trackBtn','trackTopBtn','trackMidBtn','trackBottomBtn','trackFooterBtn'].forEach(id=>$(id)?.addEventListener('click',openTrack));$('menuBtn').addEventListener('click',()=> $('mobileMenu').classList.toggle('open'));document.querySelectorAll('#mobileMenu a').forEach(a=>a.addEventListener('click',()=> $('mobileMenu').classList.remove('open')));$('searchInput').addEventListener('input',e=>{searchText=e.target.value.toLowerCase().trim();renderProducts()});document.querySelectorAll('.chip').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));b.classList.add('active');activeCategory=b.dataset.category;renderProducts()}));$('prevStepBtn').addEventListener('click',()=>setStep(checkoutStep-1));$('nextStepBtn').addEventListener('click',()=>{if(validateStep())setStep(checkoutStep+1)});document.querySelectorAll('input[name="shipping"]').forEach(x=>x.addEventListener('change',renderCheckoutSummary));
const fileInput=$('designFiles'),uploadZone=$('uploadZone');function renderFiles(){const files=[...fileInput.files];$('fileList').innerHTML=files.map(f=>`<div class="file-item"><span>${esc(f.name)}</span><strong>${(f.size/1024/1024).toFixed(2)} MB</strong></div>`).join('')}fileInput.addEventListener('change',renderFiles);['dragenter','dragover'].forEach(ev=>uploadZone.addEventListener(ev,e=>{e.preventDefault();uploadZone.classList.add('drag')}));['dragleave','drop'].forEach(ev=>uploadZone.addEventListener(ev,e=>{e.preventDefault();uploadZone.classList.remove('drag')}));uploadZone.addEventListener('drop',e=>{const dt=new DataTransfer();[...e.dataTransfer.files].slice(0,5).forEach(f=>dt.items.add(f));fileInput.files=dt.files;renderFiles()});
document.querySelectorAll('.wa-btn').forEach(btn=>btn.addEventListener('click',()=>{const msg=btn.dataset.message||`Halo ${siteSettings.siteName||'Belilas Digital Printing'}.`;window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`,'_blank')}));
$('checkoutForm').addEventListener('submit',async e=>{e.preventDefault();if(!validateStep())return;const submit=$('submitOrderBtn');submit.disabled=true;submit.textContent='Mengirim...';const order={customer:{name:$('customerName').value.trim(),phone:$('customerPhone').value.trim(),email:$('customerEmail').value.trim(),city:$('customerCity').value.trim(),address:$('customerAddress').value.trim(),note:$('customerNote').value.trim()},items:cart.map(i=>({id:i.id,qty:i.qty})),shipping:selectedShipping(),payment:document.querySelector('input[name="payment"]:checked')?.value||'transfer'};const fd=new FormData();fd.append('order',JSON.stringify(order));[...fileInput.files].forEach(f=>fd.append('designFiles',f));try{const res=await fetch('/api/orders',{method:'POST',body:fd});const data=await res.json();if(!res.ok)throw new Error(data.error||'Pesanan gagal dibuat');lastOrderId=data.orderId;cart=[];saveCart();$('checkoutForm').reset();renderFiles();hideAll();$('successOrderId').textContent=data.orderId;$('successText').textContent=`Pesanan masuk dengan estimasi total ${money(data.total)}. File terunggah: ${data.filesUploaded}. Simpan nomor pesanan ini untuk tracking.`;successModal.classList.add('open');showOverlay()}catch(err){toast(err.message)}finally{submit.disabled=false;submit.textContent='Buat Pesanan'}});$('successWaBtn').addEventListener('click',()=>{const msg=`Halo ${siteSettings.siteName||'Belilas Digital Printing'}, saya sudah membuat pesanan online dengan nomor *${lastOrderId}*. Mohon dikonfirmasi.`;window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`,'_blank')});$('trackForm').addEventListener('submit',async e=>{e.preventDefault();const id=$('trackOrderId').value.trim().toUpperCase(),phone=$('trackPhone').value.trim();$('trackResult').innerHTML='<p>Memeriksa...</p>';try{const res=await fetch(`/api/orders/${encodeURIComponent(id)}?phone=${encodeURIComponent(phone)}`);const d=await res.json();if(!res.ok)throw new Error(d.error||'Tidak ditemukan');$('trackResult').innerHTML=`<div class="track-box"><span class="status-pill">${esc(d.status)}</span><h4>${esc(d.id)}</h4><p>Atas nama ${esc(d.customer.name)} • dibuat ${new Date(d.createdAt).toLocaleString('id-ID')}</p><div class="track-lines"><div><span>Jumlah item</span><strong>${d.items.reduce((s,i)=>s+i.qty,0)}</strong></div><div><span>File desain</span><strong>${d.files.length}</strong></div><div><span>Pengiriman</span><strong>${esc(d.shipping.label)}</strong></div><div><span>Total estimasi</span><strong>${money(d.total)}</strong></div></div></div>`}catch(err){$('trackResult').innerHTML=`<div class="track-box"><strong>Belum ditemukan</strong><p>${esc(err.message)}</p></div>`}});

// INLINE WEBSITE EDIT MODE: /?edit=1
function activateInlineFields(){
  document.querySelectorAll('[data-edit]').forEach(el=>{el.contentEditable='true';el.classList.add('cms-editable')});
  $('enableEditBtn').hidden=true;
  $('inlineAdminKey').hidden=true;
  $('saveEditBtn').hidden=false;
}
async function setupInlineEditor(){
  if(!new URLSearchParams(location.search).has('edit'))return;
  const bar=$('cmsEditbar');bar.hidden=false;document.body.classList.add('has-cms-bar');
  const keyInput=$('inlineAdminKey'),enable=$('enableEditBtn'),save=$('saveEditBtn');
  try{
    const session=await fetch('/api/admin/session');
    if(session.ok){activateInlineFields();toast('Mode edit admin aktif. Klik teks yang ingin diubah.');}
  }catch{}
  enable.addEventListener('click',async()=>{
    const password=keyInput.value;
    if(!password)return toast('Masukkan password admin');
    try{
      const r=await fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
      const d=await r.json();
      if(!r.ok)throw new Error(d.error||'Password admin salah');
      keyInput.value='';activateInlineFields();toast('Mode edit aktif. Klik teks yang ingin diubah.');
    }catch(e){toast(e.message)}
  });
  save.addEventListener('click',async()=>{
    const payload={};
    document.querySelectorAll('[data-edit]').forEach(el=>payload[el.dataset.edit]=el.textContent.trim());
    if(payload.whatsappDisplay){let d=payload.whatsappDisplay.replace(/\D/g,'');payload.whatsappNumber=d.startsWith('0')?'62'+d.slice(1):d}
    try{
      const r=await fetch('/api/admin/settings',{method:'PUT',headers:{'Content-Type':'application/json','x-belilas-cms':'1'},body:JSON.stringify(payload)});
      const d=await r.json();
      if(!r.ok){if(r.status===401)throw new Error('Session admin berakhir. Login ulang melalui Dashboard CMS.');throw new Error(d.error||'Gagal menyimpan')}
      siteSettings=d.settings;WHATSAPP_NUMBER=siteSettings.whatsappNumber||WHATSAPP_NUMBER;toast('Perubahan website tersimpan');
    }catch(e){toast(e.message)}
  });
}
let toastTimer;function toast(t){const el=$('toast');el.textContent=t;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),2200)}$('year').textContent=new Date().getFullYear();
Promise.all([loadSettings(),loadProducts()]).then(setupInlineEditor).catch(()=>toast('Data website gagal dimuat. Pastikan server berjalan.'));
