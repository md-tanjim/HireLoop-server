import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import cors from 'cors';
import 'dotenv/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import Stripe from 'stripe';


//stripe setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = 5000;


app.listen(PORT, () => {
    console.log("server is running at port", PORT);
});

//---------------------------------All MiddleWire-------------------------------------------------------//
app.use(cors());
app.use(express.json());


//JWT
const varifyToken = async(req,res,next)=>{
    const authHeader = req.headers.authorization;
    // console.log(authHeader);
    if  (!authHeader) {
        return res.status(401).send({msg : 'unauthorized'});
    }
    const token = authHeader.split(" ")[1];
    // console.log(Array.isArray(token), "token");
    // console.log(token, "token");

    if (!token) {
        return res.status(401).send({msg: 'umauthorized'});
    }

    const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`))
    
    // console.log(payload, "payload");
    try {
        const {payload} = await jwtVerify(token, JWKS)
        next()
        
    } catch (error) {
    return res.status(500).send({msg: 'not varified'});
        
    }
}





//----------------------^^^-----------All MiddleWire---------------^^^----------------------------------------//

app.get('/', (req, res) => {
    res.send("server is running gooood");
})


const client = new MongoClient(`mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.ojmgvh3.mongodb.net/`);

//  console.log('client====================', client);

export async function connecToMongodb() {
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
const applicationsCollection = db.collection('applications');
const paymentsCollection = db.collection('payments');
const savedJobsCollection = db.collection("savedJobs");





//------------------------indexes---------------------------------//
// Prevent duplicate records for the same Stripe invoice.
await paymentsCollection.createIndex(
  { stripeInvoiceId: 1 },
  {
    unique: true,
    name: "unique_stripe_invoice",
  }
);

// Retrieve a user's payment history efficiently.
await paymentsCollection.createIndex(
  { userId: 1, createdAt: -1 },
  {
    name: "user_payment_history",
  }
);


// Prevent the same seeker from saving the same job twice.
await savedJobsCollection.createIndex(
    { seekerId: 1, jobId: 1 },
    {
        unique: true,
        name: "unique_saved_job_per_seeker",
    }
);

// Retrieve a seeker's saved jobs efficiently.
await savedJobsCollection.createIndex(
    { seekerId: 1, savedAt: -1 },
    {
        name: "saved_jobs_by_user",
    }
);

//-----------------^^^-------indexes-----^^^----------------------------//

//-------------------------CONSTANTS---------------------------------//
// Plan limits
const PLAN_LIMITS = {
    seeker_free: {
        accountType: "seeker",
        applicationsPerCalendarMonth: 3,
        savedJobs: 5,
        resumes: 1,
    },

    seeker_pro: {
        accountType: "seeker",
        applicationsPerCalendarMonth: null,
        savedJobs: null,
        resumes: 5,
    },

    recruiter_free: {
        accountType: "recruiter",
        activeJobListings: 3,
    },

    recruiter_pro: {
        accountType: "recruiter",
        activeJobListings: 10,
    },
};

//---------------------------^^^---------CONSTANTS----------^^^------------------------------------//







//---------------------------------ALL Stripe, Payment, Premium Ures Related APIs--------------------------//


//stripe payment varify and user update
app.post('/payment/checkout-verify', async (req, res) => {
    const { sessionId } = req.body;

    const {
        status,
        customer_email,
        metadata,
        payment_intent,
        payment_status, } =

        await stripe.checkout.sessions.retrieve(sessionId);

        // console.log("statu",status)



    // 1. Prevent duplicate processing: check if sessionId already exists in the database
        const paymentAlreadyExists = await paymentsCollection.findOne({sessionId});
        if(paymentAlreadyExists){
            return res.send({message: 'payment already verified', success:false})
        }
    // 2. Verify ownership: confirm the session belongs to the currently authenticated user
        
    // 3. Record payment: insert the verified session details into the payments collection
    
    if(status==='complete' && payment_status==='paid'){

        const paymentData = { 
            sessionId,
            status,
            customer_email,
            userId: metadata.customer_Id,
            payment_intent,
            payment_status,
        }
    
        const result = await paymentsCollection.insertOne(paymentData);
        

        // 4. update user info as premium user
        const updateResult = await usersCollection.updateOne(
            {_id: new ObjectId(metadata.customer_Id)},
            {$set:{ premium : true}}
        );

        res.send({result,updateResult, success: true});
        return;
    }

    res.send({message : 'payment varification failed', success: false});

});


//is user premium by id
app.get('/premium-user/:id',async(req,res)=>{
    const {id} = req.params;
    console.log({id});
    const result = await usersCollection.findOne(
        {_id: new ObjectId(id)},
        {projection: {premium: 1, _id: 0 }}    
    );
    // res.send({result})
    res.send(Boolean(result?.premium));
});


//-------------------^^^-------ALL Stripe, Payment, Premium Ures Related APIs---------^^^-----------------//















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




//--------------------------All Job Related Apis-----------------------------------//

// Add a new job
app.post("/add-jobs", async (req, res) => {
    try {
        const jobData = req.body;

        // 1. Get the recruiter ID from the submitted job data.
        const { createdBy, ...jobFields } = jobData;

        if (!createdBy || !ObjectId.isValid(createdBy)) {
            return res.status(400).send({
                success: false,
                message: "A valid recruiter ID is required.",
            });
        }

        const recruiterObjectId = new ObjectId(createdBy);

        // 2. Find the recruiter.
        const recruiter = await usersCollection.findOne({
            _id: recruiterObjectId,
        });

        if (!recruiter) {
            return res.status(404).send({
                success: false,
                message: "Recruiter not found.",
            });
        }

        // 3. Check account type.
        if (recruiter.accountType !== "recruiter") {
            return res.status(403).send({
                success: false,
                message: "Only recruiters can create job listings.",
            });
        }

        // 4. Check account suspension.
        if (recruiter.banned === true) {
            return res.status(403).send({
                success: false,
                message: "Your account is suspended.",
            });
        }

        // 5. Get the recruiter's plan.
        const planId = recruiter.planId || "recruiter_free";

        const userPlan = PLAN_LIMITS[planId];

        if (
            !userPlan ||
            userPlan.accountType !== "recruiter" ||
            userPlan.activeJobListings === undefined
        ) {
            return res.status(400).send({
                success: false,
                message: "Invalid recruiter plan.",
            });
        }

        // 6. Get the maximum active job listing limit.
        const jobLimit = userPlan.activeJobListings;

        // 7. Count the recruiter's existing active jobs.
        if (jobLimit !== null) {
            const activeJobCount = await jobsCollection.countDocuments({
                createdBy: {
                    $in: [
                        recruiterObjectId,
                        recruiterObjectId.toString(),
                    ],
                },

                // Older documents without listingStatus
                // are also counted as active.
                listingStatus: {
                    $ne: "closed",
                },
            });

            // 8. Reject if the recruiter reached the limit.
            if (activeJobCount >= jobLimit) {
                return res.status(403).send({
                    success: false,
                    code: "ACTIVE_JOB_LIMIT_REACHED",
                    message:
                        `You have reached your active job listing limit of ${jobLimit}. Upgrade to Recruiter Pro for more job listings.`,
                    limit: jobLimit,
                    used: activeJobCount,
                });
            }
        }

        // 9. Prepare the job document.
        const jobDocument = {
    ...jobData,
    listingStatus: "active",
};
        // const jobDocument = {
        //     ...jobFields,

        //     // Take recruiter information from MongoDB,
        //     // not from the submitted request.
        //     createdBy: recruiterObjectId,
        //     createdByName: recruiter.name,
        //     createdByEmail: recruiter.email,

        //     listingStatus: "active",

        //     createdAt: new Date(),
        //     updatedAt: new Date(),
        // };

        // 10. Insert the job into MongoDB.
        const result = await jobsCollection.insertOne(jobDocument);

        return res.status(201).json({
            success: true,
            message: "Job added successfully.",
            jobId: result.insertedId,
        });

    } catch (error) {
        console.error("Error adding job:", error);

        return res.status(500).json({
            success: false,
            message: "Internal Server Error",
        });
    }
});


// Get jobs by email for recruiter (with real applicant count)
app.get('/jobs/:email', async (req, res) => {
  const { email } = req.params;
  console.log(req.params, "request making");

  const result = await jobsCollection
    .aggregate([
      // 1. Filter jobs created by this recruiter's email
      {
        $match: {
          createdByEmail: email,
        },
      },
      // 2. Join matching documents from the "applications" collection
      {
        $lookup: {
          from: 'applications',  // Exact MongoDB collection name for applications
          localField: '_id',     // Job's _id (ObjectId)
          foreignField: 'jobId', // Application's jobId (ObjectId)
          as: 'applications',
        },
      },
      // 3. Add the `applicantCount` field using the size of the matched array
      {
        $addFields: {
          applicantCount: { $size: '$applications' },
        },
      },
      // 4. Remove the full `applications` array so the response stays lightweight
      {
        $project: {
          applications: 0,
        },
      },
    ])
    .toArray();

  res.send(result);
});


// app.get('/jobs/:email', async (req, res) => {
//     const { email } = req.params;
//     console.log(req.params, "this is params");

//     const result = await jobsCollection.find({ "createdByEmail": email }).toArray();

//     res.send(result);

// });




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
app.patch('/update-jobs/:id', async (req, res) => {
    const { id } = req.params;
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
app.get("/all-jobs", async (req, res) => {
    try {
        const query = {};
        const andConditions = [];

        // Escape special regex characters.
        const escapeRegex = (value) =>
            value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        // Convert a query parameter into an array of strings.
        // Repeated parameters are supported.
        const getStringValues = (rawValue) => {
            if (rawValue === undefined) return [];

            const values = Array.isArray(rawValue)
                ? rawValue
                : [rawValue];

            if (values.some((value) => typeof value !== "string")) {
                return null;
            }

            return values
                .map((value) => value.trim())
                .filter(Boolean);
        };

        // 1. Filter configuration
        const filterConfig = {
            jobType: {
                type: "string",
                match: "exact",
                multiple: true
            },

            category: {
                type: "string",
                match: "exact",
                multiple: true
            },

            location: {
                type: "string",
                match: "contains",
                multiple: false
            }
        };

        // 2. Dynamically process string filters
        for (const [field, config] of Object.entries(filterConfig)) {
            const values = getStringValues(req.query[field]);

            if (values === null) {
                return res.status(400).json({
                    error: `Invalid value for ${field}`
                });
            }

            if (values.length === 0) continue;

            if (!config.multiple && values.length > 1) {
                return res.status(400).json({
                    error: `Only one value is allowed for ${field}`
                });
            }

            const patterns = values.map((value) => {
                const escapedValue = escapeRegex(value);

                const pattern =
                    config.match === "exact"
                        ? `^${escapedValue}$`
                        : escapedValue;

                return new RegExp(pattern, "i");
            });

            if (config.multiple) {
                query[field] = { $in: patterns };
            } else {
                query[field] = patterns[0];
            }
        }

        // 3. Remote / On-site filter
        const remoteValues = getStringValues(req.query.isRemote);

        if (remoteValues === null) {
            return res.status(400).json({
                error: "Invalid remote filter"
            });
        }

        if (remoteValues.length > 0) {
            const booleanValues = remoteValues.map((value) =>
                value.toLowerCase()
            );

            if (
                booleanValues.some(
                    (value) => !["true", "false"].includes(value)
                )
            ) {
                return res.status(400).json({
                    error: "isRemote must be true or false"
                });
            }

            const uniqueBooleans = [
                ...new Set(
                    booleanValues.map((value) => value === "true")
                )
            ];

            query.isRemote =
                uniqueBooleans.length === 1
                    ? uniqueBooleans[0]
                    : { $in: uniqueBooleans };
        }

        // 4. Experience range filter
        const experienceValues = getStringValues(req.query.experience);

        if (experienceValues === null) {
            return res.status(400).json({
                error: "Invalid experience filter"
            });
        }

        const experienceRanges = {
            "0": { $eq: 0 },
            "1-2": { $gte: 1, $lte: 2 },
            "3-5": { $gte: 3, $lte: 5 },
            "6+": { $gte: 6 }
        };

        if (experienceValues.length > 0) {
            const experienceConditions = [];

            for (const range of experienceValues) {
                if (!Object.prototype.hasOwnProperty.call(
                    experienceRanges,
                    range
                )) {
                    return res.status(400).json({
                        error: `Invalid experience range: ${range}`
                    });
                }

                experienceConditions.push({
                    experience: experienceRanges[range]
                });
            }

            // OR between selected experience ranges.
            andConditions.push({
                $or: experienceConditions
            });
        }

        // 5. Keyword search
        if (req.query.search !== undefined) {
            if (typeof req.query.search !== "string") {
                return res.status(400).json({
                    error: "Invalid search value"
                });
            }

            const searchValue = req.query.search.trim();

            if (searchValue) {
                const searchRegex = new RegExp(
                    escapeRegex(searchValue),
                    "i"
                );

                andConditions.push({
                    $or: [
                        { title: searchRegex },
                        { companyName: searchRegex },
                        { responsibilities: searchRegex },
                        { qualifications: searchRegex }
                    ]
                });
            }
        }

        // Combine independent OR groups using AND.
        if (andConditions.length > 0) {
            query.$and = andConditions;
        }

        // 6. Pagination
        const parsePositiveInteger = (value, fallback) => {
            if (value === undefined) return fallback;

            if (
                typeof value !== "string" ||
                !/^\d+$/.test(value)
            ) {
                return null;
            }

            const number = Number(value);

            return Number.isSafeInteger(number) && number >= 1
                ? number
                : null;
        };

        const page = parsePositiveInteger(req.query.page, 1);
        const requestedLimit = parsePositiveInteger(req.query.limit, 8);

        if (page === null || requestedLimit === null) {
            return res.status(400).json({
                error: "Invalid pagination parameters"
            });
        }

        const limit = Math.min(requestedLimit, 50);
        const skip = (page - 1) * limit;

        // 7. Sorting
        const sortOptions = {
            recent: { createdAt: -1 },
            oldest: { createdAt: 1 },
            "salary-high": { maxSalary: -1 },
            "salary-low": { minSalary: 1 }
        };

        const sortKey = req.query.sort ?? "recent";

        if (
            typeof sortKey !== "string" ||
            !Object.prototype.hasOwnProperty.call(
                sortOptions,
                sortKey
            )
        ) {
            return res.status(400).json({
                error: "Invalid sorting option"
            });
        }

        // 8. Fetch jobs and count matching documents
        const [totalJobs, jobs] = await Promise.all([
            jobsCollection.countDocuments(query),

            jobsCollection.find(query).sort({
                ...sortOptions[sortKey],
                _id: -1
            }).skip(skip).limit(limit).toArray()
        ]);

        const totalPages = Math.ceil(totalJobs / limit);

        // 9. Send response
        res.send({
            jobs,
            totalJobs,
            currentPage: page,
            totalPages
        });

    } catch (error) {
        console.error("Error fetching jobs:", error);

        res.status(500).json({
            error: "Internal Server Error"
        });
    }
});





//---------------------------------------------All Job Application(for seeker) related apis-----------------------------------------------------------------------------------------------------------------------------------------//

// POST: Submit a job application (for Seeker)
// app.post("/add-applications", async (req, res) => {
//     try {
//         const { jobId, seekerId, resumeUrl } = req.body;

//         // 1. Validate required fields
//         if (!jobId || !seekerId || !resumeUrl) {
//             return res.status(400).send({
//                 success: false,
//                 message: "Job ID, seeker ID, and resume URL are required.",
//             });
//         }

//         // 2. Validate MongoDB ObjectIds
//         if (
//             !ObjectId.isValid(jobId) ||
//             !ObjectId.isValid(seekerId)
//         ) {
//             return res.status(400).send({
//                 success: false,
//                 message: "Invalid job ID or seeker ID.",
//             });
//         }

//         const jobObjectId = new ObjectId(jobId);
//         const seekerObjectId = new ObjectId(seekerId);

//         // 3. Find the job
//         const job = await jobsCollection.findOne({
//             _id: jobObjectId,
//         });

//         if (!job) {
//             return res.status(404).send({
//                 success: false,
//                 message: "Job not found.",
//             });
//         }

//         // 4. Find the seeker
//         const seeker = await usersCollection.findOne({
//             _id: seekerObjectId,
//         });

//         if (!seeker) {
//             return res.status(404).send({
//                 success: false,
//                 message: "Seeker not found.",
//             });
//         }

//         // 5. Only seekers can submit applications
//         if (seeker.accountType !== "seeker") {
//             return res.status(403).send({
//                 success: false,
//                 message: "Only job seekers can apply for jobs.",
//             });
//         }

//         // 6. Get the recruiter ID from the job document
//         if (!job.createdBy || !ObjectId.isValid(job.createdBy)) {
//             return res.status(400).send({
//                 success: false,
//                 message: "The job has an invalid recruiter reference.",
//             });
//         }

//         const recruiterObjectId = new ObjectId(job.createdBy);

//         // 7. Check for an existing application
//         const existingApplication = await applicationsCollection.findOne({
//             jobId: jobObjectId,
//             seekerId: seekerObjectId,
//         });

//         if (existingApplication) {
//             return res.status(409).send({
//                 success: false,
//                 message: "You have already applied for this job.",
//             });
//         }

//         // 8. Create the application document

//         const applicationData = {
//             jobId: jobObjectId,
//             seekerId: seekerObjectId,
//             recruiterId: recruiterObjectId,

//             applicant: {
//                 name: seeker.name,
//                 email: seeker.email,
//             },

//             resumeUrl,

//             status: "pending",

//             appliedAt: new Date(),
//             updatedAt: new Date(),

//             recruiterNote: "",
//         };

//         // 9. Insert into MongoDB
//         const result = await applicationsCollection.insertOne(
//             applicationData
//         );

//         return res.status(201).send({
//             success: true,
//             message: "Application submitted successfully.",
//             applicationId: result.insertedId,
//         });

//     } catch (error) {
//         console.error("Application submission error:", error);

//         // Handle duplicate key errors from the unique index
//         if (error.code === 11000) {
//             return res.status(409).send({
//                 success: false,
//                 message: "You have already applied for this job.",
//             });
//         }

//         return res.status(500).send({
//             success: false,
//             message: "Something went wrong while submitting your application.",
//         });
//     }
// });
//helper for submit application
function getCalendarMonthRange(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Dhaka",
        year: "numeric",
        month: "2-digit",
    }).formatToParts(now);

    const year = Number(
        parts.find((part) => part.type === "year").value
    );

    const month = Number(
        parts.find((part) => part.type === "month").value
    );

    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;

    const start = new Date(
        `${year}-${String(month).padStart(2, "0")}-01T00:00:00+06:00`
    );

    const end = new Date(
        `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+06:00`
    );

    return { start, end };
}


//POST: Submit a job application-- updated
app.post("/add-applications", async (req, res) => {
    try {
        const { jobId, seekerId, resumeUrl } = req.body;

        // 1. Validate required fields
        if (!jobId || !seekerId || !resumeUrl) {
            return res.status(400).send({
                success: false,
                message: "Job ID, seeker ID, and resume URL are required.",
            });
        }

        // 2. Validate MongoDB ObjectIds
        if (
            !ObjectId.isValid(jobId) ||
            !ObjectId.isValid(seekerId)
        ) {
            return res.status(400).send({
                success: false,
                message: "Invalid job ID or seeker ID.",
            });
        }

        const jobObjectId = new ObjectId(jobId);
        const seekerObjectId = new ObjectId(seekerId);

        // 3. Find the job
        const job = await jobsCollection.findOne({
            _id: jobObjectId,
        });

        if (!job) {
            return res.status(404).send({
                success: false,
                message: "Job not found.",
            });
        }

        // 4. Find the seeker
        const seeker = await usersCollection.findOne({
            _id: seekerObjectId,
        });

        if (!seeker) {
            return res.status(404).send({
                success: false,
                message: "Seeker not found.",
            });
        }

        // 5. Check account type
        if (seeker.accountType !== "seeker") {
            return res.status(403).send({
                success: false,
                message: "Only job seekers can apply for jobs.",
            });
        }

        // 6. Check whether the account is suspended
        if (seeker.banned === true) {
            return res.status(403).send({
                success: false,
                message: "Your account is suspended.",
            });
        }

        // 7. Get the recruiter's ID from the job
        if (!job.createdBy || !ObjectId.isValid(job.createdBy)) {
            return res.status(400).send({
                success: false,
                message: "The job has an invalid recruiter reference.",
            });
        }

        const recruiterObjectId = new ObjectId(job.createdBy);

        // 8. Check for an existing application
        const existingApplication = await applicationsCollection.findOne({
            jobId: jobObjectId,
            seekerId: seekerObjectId,
        });

        if (existingApplication) {
            return res.status(409).send({
                success: false,
                message: "You have already applied for this job.",
            });
        }

        // 9. Get the user's plan
        // Existing users without a planId temporarily default to Free.
        const planId = seeker.planId || "seeker_free";

        const userPlan = PLAN_LIMITS[planId];

        if (!userPlan || userPlan.accountType !== "seeker") {
            return res.status(400).send({
                success: false,
                message: "Invalid seeker plan.",
            });
        }

        const applicationLimit =
            userPlan.applicationsPerCalendarMonth;

        // 10. Check monthly application limit
        if (applicationLimit !== null) {
            const { start, end } = getCalendarMonthRange();

            const applicationCount =
                await applicationsCollection.countDocuments({
                    seekerId: seekerObjectId,

                    appliedAt: {
                        $gte: start,
                        $lt: end,
                    },
                });

            if (applicationCount >= applicationLimit) {
                return res.status(403).send({
                    success: false,
                    code: "APPLICATION_LIMIT_REACHED",
                    message:
                        "You have reached your monthly application limit. Upgrade to Seeker Pro for unlimited applications.",
                    limit: applicationLimit,
                    used: applicationCount,
                });
            }
        }

        // 11. Create application document
        const applicationData = {
            jobId: jobObjectId,
            seekerId: seekerObjectId,
            recruiterId: recruiterObjectId,

            applicant: {
                name: seeker.name,
                email: seeker.email,
            },

            resumeUrl,

            status: "pending",

            appliedAt: new Date(),
            updatedAt: new Date(),

            recruiterNote: "",
        };

        // 12. Insert into MongoDB
        const result = await applicationsCollection.insertOne(
            applicationData
        );

        return res.status(201).send({
            success: true,
            message: "Application submitted successfully.",
            applicationId: result.insertedId,
        });

    } catch (error) {
        console.error("Application submission error:", error);

        // Handle duplicate key errors from the unique index
        if (error.code === 11000) {
            return res.status(409).send({
                success: false,
                message: "You have already applied for this job.",
            });
        }

        return res.status(500).send({
            success: false,
            message: "Something went wrong while submitting your application.",
        });
    }
});


//--------------------------^^^^-----------------All Job Application(for seeker) related apis------^^^-----------------------------------------------------------------------------------------------------------------------------------//








//---------------------------------------------All save jobs related apis-----------------------------------------------------------------------------------------------------------------------------------------//
//save jobs

app.post("/save-job", async (req, res) => {
    try {
        const { seekerId, jobId } = req.body;

        // 1. Validate required fields
        if (!seekerId || !jobId) {
            return res.status(400).send({
                success: false,
                message: "Seeker ID and job ID are required.",
            });
        }

        // 2. Validate ObjectIds
        if (
            !ObjectId.isValid(seekerId) ||
            !ObjectId.isValid(jobId)
        ) {
            return res.status(400).send({
                success: false,
                message: "Invalid seeker ID or job ID.",
            });
        }

        const seekerObjectId = new ObjectId(seekerId);
        const jobObjectId = new ObjectId(jobId);

        // 3. Find the seeker
        const seeker = await usersCollection.findOne({
            _id: seekerObjectId,
        });

        if (!seeker) {
            return res.status(404).send({
                success: false,
                message: "Seeker not found.",
            });
        }

        // 4. Check account type
        if (seeker.accountType !== "seeker") {
            return res.status(403).send({
                success: false,
                message: "Only seekers can save jobs.",
            });
        }

        // 5. Check account suspension
        if (seeker.banned === true) {
            return res.status(403).send({
                success: false,
                message: "Your account is suspended.",
            });
        }

        // 6. Check whether the job exists
        const job = await jobsCollection.findOne({
            _id: jobObjectId,
        });

        if (!job) {
            return res.status(404).send({
                success: false,
                message: "Job not found.",
            });
        }

        // 7. Check if the job is already saved
        const existingSavedJob = await savedJobsCollection.findOne({
            seekerId: seekerObjectId,
            jobId: jobObjectId,
        });

        if (existingSavedJob) {
            return res.status(409).send({
                success: false,
                code: "JOB_ALREADY_SAVED",
                message: "You have already saved this job.",
            });
        }

        // 8. Retrieve the user's plan
        const planId = seeker.planId || "seeker_free";

        const userPlan = PLAN_LIMITS[planId];

        if (
            !userPlan ||
            userPlan.accountType !== "seeker" ||
            userPlan.savedJobs === undefined
        ) {
            return res.status(400).send({
                success: false,
                message: "Invalid seeker plan.",
            });
        }

        // 9. Check saved-job limit
        const savedJobLimit = userPlan.savedJobs;

        if (savedJobLimit !== null) {
            const savedJobCount =
                await savedJobsCollection.countDocuments({
                    seekerId: seekerObjectId,
                });

            if (savedJobCount >= savedJobLimit) {
                return res.status(403).send({
                    success: false,
                    code: "SAVED_JOB_LIMIT_REACHED",
                    message:
                        "You have reached your saved jobs limit. Upgrade to Seeker Pro for unlimited saved jobs.",
                    limit: savedJobLimit,
                    used: savedJobCount,
                });
            }
        }

        // 10. Create the saved job document
        const savedJobData = {
            seekerId: seekerObjectId,
            jobId: jobObjectId,
            savedAt: new Date(),
        };

        // 11. Insert into MongoDB
        const result = await savedJobsCollection.insertOne(
            savedJobData
        );

        return res.status(201).send({
            success: true,
            message: "Job saved successfully.",
            savedJobId: result.insertedId,
        });

    } catch (error) {
        console.error("Save job error:", error);

        // Handle duplicate key errors
        if (error.code === 11000) {
            return res.status(409).send({
                success: false,
                message: "You have already saved this job.",
            });
        }

        return res.status(500).send({
            success: false,
            message: "Something went wrong while saving the job.",
        });
    }
});

//get saved jobs

app.get("/saved-jobs/:seekerId", async (req, res) => {
    try {
        const { seekerId } = req.params;

        // 1. Validate seeker ID
        if (!ObjectId.isValid(seekerId)) {
            return res.status(400).send({
                success: false,
                message: "Invalid seeker ID.",
            });
        }

        const seekerObjectId = new ObjectId(seekerId);

        // 2. Find the seeker
        const seeker = await usersCollection.findOne({
            _id: seekerObjectId,
        });

        if (!seeker) {
            return res.status(404).send({
                success: false,
                message: "Seeker not found.",
            });
        }

        if (seeker.accountType !== "seeker") {
            return res.status(403).send({
                success: false,
                message: "Only seekers can access saved jobs.",
            });
        }

        if (seeker.banned === true) {
            return res.status(403).send({
                success: false,
                message: "Your account is suspended.",
            });
        }

        // 3. Find the saved-job records
        const savedRecords = await savedJobsCollection
            .find({ seekerId: seekerObjectId })
            .sort({ savedAt: -1 })
            .toArray();

        // 4. Get the job IDs
        const jobIds = savedRecords.map(
            (record) => record.jobId
        );

        // 5. Retrieve actual job documents
        const jobs = await jobsCollection.find({
            _id: { $in: jobIds },
        }).toArray();

        // 6. Match each job with its saved date
        const jobsMap = new Map(
            jobs.map((job) => [
                job._id.toString(),
                job,
            ])
        );

        const savedJobs = savedRecords
            .map((record) => {
                const job = jobsMap.get(
                    record.jobId.toString()
                );

                if (!job) return null;

                return {
                    ...job,
                    savedAt: record.savedAt,
                };
            })
            .filter(Boolean);

        return res.status(200).send({
            success: true,
            savedJobs,
            savedCount: savedJobs.length,
        });

    } catch (error) {
        console.error("Get saved jobs error:", error);

        return res.status(500).send({
            success: false,
            message: "Something went wrong while retrieving saved jobs.",
        });
    }
});



//delete saved job

app.delete(
    "/remove-saved-job/:seekerId/:jobId",
    async (req, res) => {
        try {
            const { seekerId, jobId } = req.params;

            // 1. Validate IDs
            if (
                !ObjectId.isValid(seekerId) ||
                !ObjectId.isValid(jobId)
            ) {
                return res.status(400).send({
                    success: false,
                    message: "Invalid seeker ID or job ID.",
                });
            }

            const seekerObjectId = new ObjectId(seekerId);
            const jobObjectId = new ObjectId(jobId);

            // 2. Find the seeker
            const seeker = await usersCollection.findOne({
                _id: seekerObjectId,
            });

            if (!seeker) {
                return res.status(404).send({
                    success: false,
                    message: "Seeker not found.",
                });
            }

            if (seeker.accountType !== "seeker") {
                return res.status(403).send({
                    success: false,
                    message: "Only seekers can remove saved jobs.",
                });
            }

            if (seeker.banned === true) {
                return res.status(403).send({
                    success: false,
                    message: "Your account is suspended.",
                });
            }

            // 3. Delete the saved-job record
            const result = await savedJobsCollection.deleteOne({
                seekerId: seekerObjectId,
                jobId: jobObjectId,
            });

            if (result.deletedCount === 0) {
                return res.status(404).send({
                    success: false,
                    message: "Saved job not found.",
                });
            }

            return res.status(200).send({
                success: true,
                message: "Job removed from saved jobs.",
            });

        } catch (error) {
            console.error("Remove saved job error:", error);

            return res.status(500).send({
                success: false,
                message: "Something went wrong while removing the saved job.",
            });
        }
    }
);





//----------------------------------^^^----All jobs save related apis-------^^^^^-------------------------------------------------------------------------------------------------------------------//

//count application by id
app.get('/applications/count', async (req, res) => {
  const { seekerId } = req.query;

  // Return 0 if seekerId is missing or invalid so it doesn't count the whole collection
  if (!seekerId || !ObjectId.isValid(seekerId)) {
    return res.send({ count: 0 });
  }

  const query = {
    seekerId: new ObjectId(seekerId),
  };

  const result = await applicationsCollection.countDocuments(query);
  res.send({ count: result });
});



// get all applicants info and job info
app.get('/candidates/:id', async (req, res) => {
  const { id } = req.params; //id is for jobId

  if (!ObjectId.isValid(id)) {
    return res.status(400).send({ message: 'Invalid job ID' });
  }

  const results = await jobsCollection.aggregate([
      // Stage 1: Separate object for $match
      {
        $match: {
          _id: new ObjectId(id),
        },
      },
      // Stage 2: Separate object for $lookup
      {
        $lookup: {
          from: 'applications',
          localField: '_id',
          foreignField: 'jobId',
          as: 'candidates',
        },
      },
    ])
    .toArray();

  // Return the single job object (with its `candidates` array inside)
  res.send(results[0] || null); 
});






//----------------------------All ADIMIN APIs-----------------------------------------//
//update role (admin api)
app.patch('/update/user/:id', async(req,res)=>{
    const {id} = req.params;

    const result = await usersCollection.updateOne(
        {_id : new ObjectId(id)},
        {$set:{accountType: req.body.accountType}}
    );

    res.send(result);
});



//----------------^^^------------All ADIMIN APIs------^^^-----------------------------------//