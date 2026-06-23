const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');

let db, doctorsCollection, usersCollection, bookingsCollection;
let currentUserSession = "";

// الرابط السحابي الحقيقي (هيقراه السيرفر أونلاين تلقائياً عند العميل)
const REAL_MONGO_URI = process.env.MONGO_URI; 

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD_HASH = '01b307acba4f54f55aafc33bb06bbbf6ca803e9a37c083147925a141b538e11b'; 

async function startServer() {
    try {
        if (REAL_MONGO_URI) {
            console.log("⏳ جاري الاتصال بـ MongoDB Atlas السحابية الحقيقية...");
            const client = new MongoClient(REAL_MONGO_URI);
            await client.connect();
            db = client.db('elshifa_hospital');
            console.log("🍃 تم الاتصال بـ MongoDB Atlas بنجاح!");
        } else {
            console.log("⏳ جاري تشغيل MongoDB المحلية المؤقتة...");
            const mongoServer = await MongoMemoryServer.create({
                instance: { port: 27017, dbName: 'elshifa_hospital' }
            });
            const uri = mongoServer.getUri();
            const client = new MongoClient(uri);
            await client.connect();
            db = client.db('elshifa_hospital');
            console.log("🍃 تم تشغيل MongoDB المحلية بنجاح!");
        }

        doctorsCollection = db.collection('doctors');
        usersCollection = db.collection('users');
        bookingsCollection = db.collection('bookings');
        
        const docCount = await doctorsCollection.countDocuments();
        if (docCount === 0) {
            await doctorsCollection.insertMany([
                { id: 1, name: "د. أحمد كمال", specialty: "باطنة", branch: "القاهرة", bio: "استشاري الباطنة والجهاز الهضمي بمستشفيات جامعة عين شمس.", image: "https://images.unsplash.com/photo-1622253692010-333f2da6031d?auto=format&fit=crop&w=400&q=80", schedule: { "السبت": "10:00 ص - 02:00 ظ", "الأحد": "12:00 ظ - 04:00 ع" } },
                { id: 2, name: "د. خالد محروس", specialty: "باطنة", branch: "الجيزة", bio: "أخصائي الغدد الصماء والسكري بمستشفى القصر العيني.", image: "https://images.unsplash.com/photo-1537368910025-700350fe46c7?auto=format&fit=crop&w=400&q=80", schedule: { "الإثنين": "01:00 ظ - 05:00 م" } },
                { id: 3, name: "د. سارة المنصوري", specialty: "عيون", branch: "الإسكندرية", bio: "استشاري جراحات العيون وتصحيح الإبصار بالليزر.", image: "https://images.unsplash.com/photo-1594824813573-246434de83fb?auto=format&fit=crop&w=400&q=80", schedule: { "الثلاثاء": "11:00 ص - 03:00 ظ" } }
            ]);
            console.log("🎯 تم ضخ بيانات الأطباء المبدئية.");
        }
        
        startHttpServer();
    } catch (err) {
        console.error("❌ فشل تشغيل الداتابيز:", err);
    }
}

const server = http.createServer(async (req, res) => {
    let decodedUrl = decodeURIComponent(req.url);

    if (decodedUrl === '/api/doctors' && req.method === 'GET') {
        const doctors = await doctorsCollection.find({}).toArray();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(doctors));
    }

    if (decodedUrl === '/api/admin/doctors' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            const doc = JSON.parse(body);
            if (doc.id) {
                delete doc._id;
                await doctorsCollection.updateOne({ id: parseInt(doc.id) }, { $set: doc });
            } else {
                const allDocs = await doctorsCollection.find({}).toArray();
                let maxId = 0;
                allDocs.forEach(d => { if (d.id > maxId) maxId = d.id; });
                doc.id = maxId + 1;
                await doctorsCollection.insertOne(doc);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    if (decodedUrl.startsWith('/api/admin/doctors/delete/') && req.method === 'POST') {
        const id = parseInt(decodedUrl.split('/').pop());
        await doctorsCollection.deleteOne({ id: id });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
    }

    if (decodedUrl === '/api/auth/signup' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            const newUser = JSON.parse(body);
            const exist = await usersCollection.findOne({ user: newUser.user });
            if(exist) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, message: "اسم المستخدم محجوز مسبقاً" }));
            }
            newUser.pass = hashPassword(newUser.pass); 
            await usersCollection.insertOne(newUser);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    if (decodedUrl === '/api/auth/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            const { user, pass } = JSON.parse(body);
            const incomingPasswordHash = hashPassword(pass);

            if (user === ADMIN_USERNAME && incomingPasswordHash === ADMIN_PASSWORD_HASH) {
                currentUserSession = "admin";
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, user: { name: "مدير النظام", role: "admin" } }));
            }
            
            const foundUser = await usersCollection.findOne({ user: user, pass: incomingPasswordHash });
            if (foundUser) {
                currentUserSession = foundUser.user;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    user: { name: foundUser.name, user: foundUser.user, phone: foundUser.phone || foundUser.mobile || "", role: "patient" } 
                }));
            } else {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: "بيانات الدخول غير صحيحة" }));
            }
        });
        return;
    }

    if ((decodedUrl === '/api/auth/update' || decodedUrl === '/api/profile/update' || decodedUrl === '/api/user/update') && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const updateData = JSON.parse(body);
                const targetUser = updateData.user || currentUserSession;

                if (!targetUser) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: false, message: "لم يتم تحديد المستخدم" }));
                }

                const finalPhone = updateData.phone || updateData.mobile || "";
                const finalName = updateData.name || updateData.username || "";

                await usersCollection.updateOne(
                    { user: targetUser },
                    { $set: { name: finalName, phone: finalPhone, mobile: finalPhone } }
                );

                const updatedUser = await usersCollection.findOne({ user: targetUser });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true, 
                    user: { name: updatedUser.name, user: updatedUser.user, phone: updatedUser.phone, role: "patient" }
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: "حدث خطأ أثناء الحفظ" }));
            }
        });
        return;
    }

    if (decodedUrl === '/api/bookings' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            const newBooking = JSON.parse(body);
            const allBookings = await bookingsCollection.find({}).toArray();
            let maxBookingId = 0;
            allBookings.forEach(b => { if (b.id > maxBookingId) maxBookingId = b.id; });

            newBooking.id = maxBookingId + 1;
            newBooking.status = "قيد المراجعة";
            await bookingsCollection.insertOne(newBooking);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    if (decodedUrl === '/api/admin/bookings' && req.method === 'GET') {
        const bookings = await bookingsCollection.find({}).toArray();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(bookings));
    }

    if ((decodedUrl.startsWith('/api/admin/bookings/status') || decodedUrl.startsWith('/api/bookings/status') || decodedUrl.startsWith('/api/admin/bookings/update')) && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const bookingId = parseInt(data.id || data.bookingId || decodedUrl.split('/').pop());
                const newStatus = data.status;

                await bookingsCollection.updateOne(
                    { id: bookingId },
                    { $set: { status: newStatus } }
                );

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false }));
            }
        });
        return;
    }

    let filePath = path.join(__dirname, 'public', decodedUrl === '/' ? 'index.html' : decodedUrl);
    if (!path.extname(filePath)) filePath += '.html';

    let extname = path.extname(filePath);
    let contentType = 'text/html';
    if (extname === '.css') contentType = 'text/css';
    if (extname === '.js') contentType = 'application/javascript';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h1>404 - الملف مش موجود جوه فولدر public</h1>');
        } else {
            res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
            res.end(content);
        }
    });
});

let PORT = process.env.PORT || 8000;
function startHttpServer() {
    server.listen(PORT, () => {
        console.log(`🚀 السيرفر شغال وجاهز على بورت: ${PORT}`);
    });
}

startServer();