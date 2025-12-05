import express from 'express';
import router from './routes.js';
import cors from 'cors';

const port = process.env.PORT || 7205;
const app = express();

// middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(cors());

app.use('/api', router);

// Start server
app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});