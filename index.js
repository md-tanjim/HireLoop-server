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


// Get all users
app.get('/users', async (req, res) => {
    try {
        const users = await usersCollection.find().toArray();
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// Add a new job
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
});

// Get jobs by email
app.get('/jobs/:email',async(req,res)=>{
    const {email} = req.params;
    console.log(req.params,"this is params");


    const result = await jobsCollection.find({ "createdByEmail": email }).toArray();

    res.send(result);

});

//delete job by id
app.delete('/delete-job/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await jobsCollection.deleteOne({ _id: new ObjectId(id) });
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }
        res.json({ message: 'Job deleted successfully' });
    } catch (error) {
        console.error('Error deleting job:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

//update job by id
app.patch('/update-jobs/:id',async(req,res)=>{
    const {id} = req.params;
    const jobData = req.body;
    try {
        const result = await jobsCollection.updateOne({ _id: new ObjectId(id) }, { $set: jobData });
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }
        res.json({ message: 'Job updated successfully' });
    } catch (error) {
        console.error('Error updating job:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
    
});

//get job by id
app.get('/job/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const job = await jobsCollection.findOne({ _id: new ObjectId(id) });
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        res.json(job);

    } catch (error) {
        console.error('Error fetching job:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


//get all jobs
// app.get('/all-jobs', async(req,res)=>{
//      const query = {};
//     //  console.log('query=========', req.query)
//        if (req.query.jobType) {
//     // Escapes special characters and matches case-insensitively ("i")
//     const escapedJobType = req.query.jobType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
//     query.jobType = { $regex: `^${escapedJobType}$`, $options: 'i' };
//   }
//     const results = await jobsCollection.find(query).toArray();
//     res.send(results);
// });


app.get("/all-jobs", async (req, res) => {
  try {
    const query = {};

    const escapeRegex = (value) =>
      value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // 1. Filter configuration
    const filterConfig = {
      jobType: { type: "string", match: "exact" },
      category: { type: "string", match: "exact" },
      location: { type: "string", match: "contains" },
      experience: { type: "number" },
      isRemote: { type: "boolean" }
    };

    // 2. Dynamically build filters
    for (const [field, config] of Object.entries(filterConfig)) {
      const value = req.query[field];

      if (value === undefined || value === "") continue;

      if (typeof value !== "string") {
        return res.status(400).json({
          error: `Invalid value for ${field}`
        });
      }

      if (config.type === "string") {
        const escapedValue = escapeRegex(value.trim());

        if (!escapedValue) continue;

        //query updated
        query[field] =
          config.match === "exact"
            ? {
                $regex: `^${escapedValue}$`,
                $options: "i"
              }
            : {
                $regex: escapedValue,
                $options: "i"
              };
      }

      else if (config.type === "number") {
        const numberValue = Number(value);

        if (!Number.isFinite(numberValue) || numberValue < 0) {
          return res.status(400).json({
            error: `Invalid number for ${field}`
          });
        }

        //query updated
        query[field] = numberValue;
      }

      else if (config.type === "boolean") {
        const booleanValue = value.toLowerCase();

        if (!["true", "false"].includes(booleanValue)) {
          return res.status(400).json({
            error: `Invalid boolean for ${field}`
          });
        }

        //query updated
        query[field] = booleanValue === "true";
      }
    }

    // 3. Search across multiple fields
    if (typeof req.query.search === "string" && req.query.search.trim()) {
      const searchValue = escapeRegex(req.query.search.trim());

      query.$or = [
        { title: { $regex: searchValue, $options: "i" } },
        { companyName: { $regex: searchValue, $options: "i" } },
        { responsibilities: { $regex: searchValue, $options: "i" } },
        { qualifications: { $regex: searchValue, $options: "i" } }
      ];
    }

    // 4. Fetch matching jobs
    const results = await jobsCollection.find(query).toArray();

    res.send(results);

  } catch (error) {
    console.error("Error fetching jobs:", error);

    res.status(500).json({
      error: "Internal Server Error"
    });
  }
});
