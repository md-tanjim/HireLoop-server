import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import cors from 'cors';
import 'dotenv/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';


const app = express();
const PORT = 5000; 


app.listen(PORT, ()=>{
    console.log("server is running at port", PORT );
});

//middle wire
app.use(cors());
app.use(express.json());


app.get('/', (req,res)=>{
    res.send("server is running gooood");
})


const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ojmgvh3.mongodb.net/`);

//  console.log('client====================', client);

export async function connecToMongodb(){
    try {
        await client.connect();
        console.log('successfully connected too mongodb');
        return client;

    } catch (error) {
        
    }
}


//Mnogodb Database(hireloopdb) and collection(jobs)  connection
const connectedClient = await connecToMongodb();
const db = connectedClient.db('hireloopdb');
const jobsCollection = db.collection('jobs');
const usersCollection = db.collection('user');

// const bookingCollection = db.collection('my-bookings');
// const myListingsCollection = db.collection('my-listings');

app.get('/users', async (req, res) => {
    try {
        const users = await usersCollection.find().toArray();
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});



app.post('/add-jobs', async (req, res) => {
    const jobData = req.body;
    console.log('Received job data:', jobData);
    try {
        const result = await jobsCollection.insertOne(jobData);
        res.status(201).json({ message: 'Job added successfully', jobId: result.insertedId });
    } catch (error) {
        console.error('Error adding job:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
})
