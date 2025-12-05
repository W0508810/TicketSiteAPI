import express from 'express';
import sql from 'mssql';
import 'dotenv/config'

const router = express.Router();

// Database configuration
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  server: process.env.DB_SERVER,
  port: 1433, // Azure SQL port
  options: {
    encrypt: true, // Required for Azure SQL
    trustServerCertificate: false,
    enableArithAbort: true
  }
};

// ========== 1. TEST ENDPOINTS ==========


// GET: All upcoming shows
router.get("/shows/upcoming", async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    const result = await pool.request().query(`
      SELECT 
        s.ShowId,
        s.ShowName,
        s.ShowDescription,
        s.ShowDate,
        s.TicketPrice,
        c.Name AS Category,
        v.VenueName AS Venue,
        v.Location AS VenueLocation,
        v.VenueCapacity,
        s.ImageFileName,
        COUNT(t.TicketId) as AvailableTickets
      FROM dbo.Show s
      JOIN dbo.Category c ON s.CategoryId = c.CategoryId
      JOIN dbo.Venue v ON s.VenueId = v.VenueId
      LEFT JOIN dbo.Ticket t ON s.ShowId = t.ShowId AND t.IsAvailable = 1
      WHERE s.ShowDate >= GETDATE()
      GROUP BY 
        s.ShowId, s.ShowName, s.ShowDescription, s.ShowDate, 
        s.TicketPrice, c.Name, v.VenueName, v.Location, 
        v.VenueCapacity, s.ImageFileName
      ORDER BY s.ShowDate ASC;
    `);
    
    res.json({
      success: true,
      count: result.recordset.length,
      data: result.recordset
    });
  } catch (err) {
    console.error("❌ Error fetching upcoming shows:", err);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

// GET: Single show by ID
router.get("/shows/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await sql.connect(dbConfig);
    
    const result = await pool.request()
      .input('showId', sql.Int, id)
      .query(`
        SELECT 
          s.ShowId,
          s.ShowName,
          s.ShowDescription,
          s.ShowDate,
          s.TicketPrice,
          c.Name AS Category,
          v.VenueName AS Venue,
          v.Location AS VenueLocation,
          v.VenueCapacity,
          s.ImageFileName,
          (SELECT COUNT(*) FROM Ticket WHERE ShowId = s.ShowId AND IsAvailable = 1) as AvailableTickets
        FROM dbo.Show s
        JOIN dbo.Category c ON s.CategoryId = c.CategoryId
        JOIN dbo.Venue v ON s.VenueId = v.VenueId
        WHERE s.ShowId = @showId;
      `);
    
    if (result.recordset.length === 0) {
      res.status(404).json({ 
        success: false,
        message: 'Show not found.' 
      });
    } else {
      res.json({
        success: true,
        data: result.recordset[0]
      });
    }
  } catch (err) {
    console.error("❌ Error fetching show by ID:", err);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

// ========== 3. CUSTOMER/ORDER ENDPOINTS ==========


// GET: All customers with contact details
router.get("/customers", async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    
    const result = await pool.request().query(`
      SELECT 
        UserId,
        UserName,
        Email,
        -- Masked payment card for display
        CONCAT('**** **** **** ', RIGHT(PaymentCardNumber, 4)) as MaskedPaymentCard,
        CardHolderName,
        CardExpiry,
        -- Count orders
        (SELECT COUNT(*) FROM [Order] WHERE UserId = u.UserId) as TotalOrders,
        -- Last order date
        (SELECT MAX(OrderDate) FROM [Order] WHERE UserId = u.UserId) as LastOrderDate,
        -- Total spent
        (SELECT ISNULL(SUM(t.Price), 0) 
         FROM [Order] o 
         JOIN Ticket t ON o.TicketId = t.TicketId 
         WHERE o.UserId = u.UserId) as TotalSpent
      FROM dbo.[User] u
      ORDER BY UserName ASC;
    `);
    
    res.json({
      success: true,
      count: result.recordset.length,
      data: result.recordset
    });
  } catch (err) {
    console.error("❌ Error fetching customers:", err);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

// GET: Customer purchase information
router.get("/customers/:userId/orders", async (req, res) => {
  try {
    const { userId } = req.params;
    const pool = await sql.connect(dbConfig);
    
    const result = await pool.request()
      .input('userId', sql.Int, userId)
      .query(`
        SELECT 
          o.OrderId,
          o.OrderDate,
          o.UseCustomPayment,
          t.TicketId,
          t.SeatNumber,
          t.Price as TicketPrice,
          s.ShowName,
          s.ShowDate as ShowDateTime,
          v.VenueName,
          CASE 
            WHEN o.UseCustomPayment = 1 
              THEN CONCAT('**** **** **** ', RIGHT(o.CustomCardNumber, 4))
            ELSE CONCAT('**** **** **** ', RIGHT(u.PaymentCardNumber, 4))
          END as MaskedCardNumber
        FROM dbo.[Order] o
        JOIN dbo.[User] u ON o.UserId = u.UserId
        LEFT JOIN dbo.Ticket t ON o.TicketId = t.TicketId
        LEFT JOIN dbo.Show s ON t.ShowId = s.ShowId
        LEFT JOIN dbo.Venue v ON t.VenueId = v.VenueId
        WHERE o.UserId = @userId
        ORDER BY o.OrderDate DESC;
      `);
    
    if (result.recordset.length === 0) {
      res.status(404).json({ 
        success: false,
        message: 'No orders found for this user.' 
      });
    } else {
      res.json({
        success: true,
        count: result.recordset.length,
        data: result.recordset
      });
    }
  } catch (err) {
    console.error("❌ Error fetching customer orders:", err);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

// POST: Create a new order
router.post("/orders", async (req, res) => {
  try {
    const { userId, ticketId, useCustomPayment = false, customCardNumber, customCardHolder, customCardExpiry } = req.body;
    
    // Validate input
    if (!userId || !ticketId) {
      return res.status(400).json({ 
        success: false,
        error: "userId and ticketId are required." 
      });
    }
    
    const pool = await sql.connect(dbConfig);
    // In routes.js, update the available tickets endpoint:
router.get("/tickets/available", async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    
    const result = await pool.request().query(`
      SELECT 
        t.TicketId,
        t.SeatNumber,
        t.Price,
        t.IsAvailable,
        t.ShowId,  
        s.ShowName,
        s.ShowDate,
        v.VenueName,
        v.Location
      FROM dbo.Ticket t
      JOIN dbo.Show s ON t.ShowId = s.ShowId
      JOIN dbo.Venue v ON t.VenueId = v.VenueId
      WHERE t.IsAvailable = 1 AND t.OrderId IS NULL
      ORDER BY s.ShowDate ASC;
    `);
    
    res.json({
      success: true,
      count: result.recordset.length,
      data: result.recordset
    });
  } catch (err) {
    console.error("❌ Error fetching available tickets:", err);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

    // Insert new order
    const result = await pool.request()
      .input('userId', sql.Int, userId)
      .input('ticketId', sql.Int, ticketId)
      .input('useCustomPayment', sql.Bit, useCustomPayment)
      .input('customCardNumber', sql.NVarChar, customCardNumber || null)
      .input('customCardHolder', sql.NVarChar, customCardHolder || null)
      .input('customCardExpiry', sql.NVarChar, customCardExpiry || null)
      .query(`
        INSERT INTO dbo.[Order] (UserId, TicketId, OrderDate, UseCustomPayment, CustomCardNumber, CustomCardHolder, CustomCardExpiry)
        OUTPUT INSERTED.OrderId, INSERTED.UserId, INSERTED.TicketId, INSERTED.OrderDate, INSERTED.UseCustomPayment
        VALUES (@userId, @ticketId, GETDATE(), @useCustomPayment, @customCardNumber, @customCardHolder, @customCardExpiry);
      `);
    
    // Update ticket to mark as sold
    await pool.request()
      .input('ticketId', sql.Int, ticketId)
      .input('orderId', sql.Int, result.recordset[0].OrderId)
      .query(`
        UPDATE dbo.Ticket 
        SET OrderId = @orderId, 
            IsAvailable = 0 
        WHERE TicketId = @ticketId;
      `);
    
    res.status(201).json({
      success: true,
      message: 'Order created successfully.',
      data: result.recordset[0]
    });
    
  } catch (err) {
    console.error("❌ Error creating order:", err);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

// ========== 4. PAYMENT ENDPOINTS ==========

// GET: All payment/credit card details
router.get("/payments", async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    
    const result = await pool.request().query(`
      SELECT 
        -- User default payment cards
        u.UserId,
        u.UserName,
        u.Email,
        'User Default' as PaymentType,
        u.PaymentCardNumber as FullCardNumber,
        CONCAT('**** **** **** ', RIGHT(u.PaymentCardNumber, 4)) as MaskedCardNumber,
        u.CardHolderName,
        u.CardExpiry,
        u.CardCVV,
        NULL as OrderId,
        NULL as OrderDate
      FROM dbo.[User] u
      WHERE u.PaymentCardNumber IS NOT NULL AND LTRIM(RTRIM(u.PaymentCardNumber)) != ''
      
      UNION ALL
      
      SELECT 
        -- Custom payment cards from orders
        u.UserId,
        u.UserName,
        u.Email,
        'Order Custom Payment' as PaymentType,
        o.CustomCardNumber as FullCardNumber,
        CONCAT('**** **** **** ', RIGHT(o.CustomCardNumber, 4)) as MaskedCardNumber,
        o.CustomCardHolder as CardHolderName,
        o.CustomCardExpiry as CardExpiry,
        NULL as CardCVV, -- CVV not stored for custom payments
        o.OrderId,
        o.OrderDate
      FROM dbo.[Order] o
      JOIN dbo.[User] u ON o.UserId = u.UserId
      WHERE o.UseCustomPayment = 1 
        AND o.CustomCardNumber IS NOT NULL 
        AND LTRIM(RTRIM(o.CustomCardNumber)) != ''
      
      ORDER BY UserName, PaymentType, OrderDate DESC;
    `);
    
    res.json({
      success: true,
      count: result.recordset.length,
      data: result.recordset
    });
  } catch (err) {
    console.error("❌ Error fetching payment details:", err);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

// ========== 5. TICKET ENDPOINTS ==========

// GET: All available tickets
// GET: Available tickets for a specific show
router.get("/shows/:id/tickets", async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await sql.connect(dbConfig);
    
    const result = await pool.request()
      .input('showId', sql.Int, id)
      .query(`
        SELECT 
          t.TicketId,
          t.SeatNumber,
          t.Price,
          t.IsAvailable,
          s.ShowName,
          v.VenueName
        FROM dbo.Ticket t
        JOIN dbo.Show s ON t.ShowId = s.ShowId
        JOIN dbo.Venue v ON t.VenueId = v.VenueId
        WHERE t.ShowId = @showId 
          AND t.IsAvailable = 1 
          AND t.OrderId IS NULL
        ORDER BY t.Price DESC;
      `);
    
    res.json({
      success: true,
      count: result.recordset.length,
      data: result.recordset
    });
  } catch (err) {
    console.error("❌ Error fetching show tickets:", err);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

// ========== 6. VENUE & CATEGORY ENDPOINTS ==========

// GET: All venues
router.get("/venues", async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    
    const result = await pool.request().query(`
      SELECT 
        VenueId,
        VenueName,
        Location,
        VenueCapacity
      FROM dbo.Venue
      ORDER BY VenueName ASC;
    `);
    
    res.json({
      success: true,
      count: result.recordset.length,
      data: result.recordset
    });
  } catch (err) {
    console.error("❌ Error fetching venues:", err);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

// GET: All categories
router.get("/categories", async (req, res) => {
  try {
    const pool = await sql.connect(dbConfig);
    
    const result = await pool.request().query(`
      SELECT 
        CategoryId,
        Name
      FROM dbo.Category
      ORDER BY Name ASC;
    `);
    
    res.json({
      success: true,
      count: result.recordset.length,
      data: result.recordset
    });
  } catch (err) {
    console.error("❌ Error fetching categories:", err);
    res.status(500).json({ 
      success: false,
      error: "Internal server error" 
    });
  }
});

export default router;