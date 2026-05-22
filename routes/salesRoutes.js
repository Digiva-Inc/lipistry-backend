const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticateAndAuthorize = require("../middleware/authMiddleware");

// ======================================================
// QUERY HELPER
// ======================================================

const query = (sql, params) =>
  new Promise((resolve, reject) => {
    db.query(sql, params, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });

// ======================================================
// CREATE SALE
// ======================================================

router.post(
  "/create",
  authenticateAndAuthorize(),
  async (req, res) => {

    const {
      date,
      bill_no,
      customer_name,
      vehicle_no,
      driver_name,
      driver_number,
      transporter_name,
      lr_number,
      items,
    } = req.body;

    if (
      !date ||
      !bill_no ||
      !customer_name ||
      !driver_name
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    try {

      const itemsToProcess = items || [];

      // =========================
      // STOCK VALIDATION
      // =========================

      const aggregatedQuantities = {};

      for (const item of itemsToProcess) {

        const q =
          parseInt(item.quantity, 10) || 0;

        aggregatedQuantities[
          item.product_code
        ] =
          (
            aggregatedQuantities[
              item.product_code
            ] || 0
          ) + q;

      }

      for (const code in aggregatedQuantities) {

        const totalNeeded =
          aggregatedQuantities[code];

        const stockResult = await query(
          `
          SELECT quantity, product_name
          FROM product
          WHERE product_code = ?
          `,
          [code]
        );

        if (stockResult.length === 0) {
          return res.status(400).json({
            success: false,
            message:
              `Product ${code} missing in DB`,
          });
        }

        if (
          stockResult[0].quantity <
          totalNeeded
        ) {
          return res.status(400).json({
            success: false,
            message:
              `Insufficient stock for ${stockResult[0].product_name}`,
          });
        }

      }

      // =========================
      // AUTO STATUS
      // =========================

      const autoStatus =
        itemsToProcess.length > 0
          ? "stock_out"
          : "pending";

      const basicProductCode =
        itemsToProcess[0]?.product_code || "";

      const basicQuantity =
        itemsToProcess[0]?.quantity || 0;

      const created_by = req.user.name;

      // =========================
      // CREATE SALE
      // =========================

      const insertResult = await query(
        `
        INSERT INTO sales
        (
          date,
          bill_no,
          customer_name,
          vehicle_no,
          driver_name,
          driver_number,
          transporter_name,
          lr_number,
          product_code,
          quantity,
          created_by,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          date,
          bill_no,
          customer_name,
          vehicle_no || "",
          driver_name,
          driver_number || "",
          transporter_name || "",
          lr_number || "",
          basicProductCode,
          basicQuantity,
          created_by,
          autoStatus,
        ]
      );

      const salesId = insertResult.insertId;

      // =========================
      // INSERT ITEMS
      // =========================

      for (const item of itemsToProcess) {

        const parsedQuantity = parseInt(
          item.quantity,
          10
        );

        // INSERT ITEM

        await query(
          `
          INSERT INTO sales_items
          (
            sales_id,
            product_code,
            product_name,
            gradation,
            quantity
          )
          VALUES (?, ?, ?, ?, ?)
          `,
          [
            salesId,
            item.product_code,
            item.product_name,
            item.gradation,
            parsedQuantity,
          ]
        );

        // REMOVE STOCK

        await query(
          `
          UPDATE product
          SET quantity = quantity - ?
          WHERE product_code = ?
          `,
          [
            parsedQuantity,
            item.product_code,
          ]
        );

      }

      res.json({
        success: true,
        message: "Sale created successfully",
        insertedId: salesId,
      });

    } catch (err) {

      console.error(
        "Sales Insert Error:",
        err
      );

      res.status(500).json({
        success: false,
        message: "Insert Error",
        error: err.message,
      });

    }

  }
);

// ======================================================
// UPDATE SALE
// ======================================================

router.put(
  "/update/:id",
  authenticateAndAuthorize(),
  async (req, res) => {

    const saleId = req.params.id;

    const {
      date,
      bill_no,
      customer_name,
      vehicle_no,
      driver_name,
      driver_number,
      transporter_name,
      lr_number,
      items,
    } = req.body;

    const itemsToProcess = items || [];

    if (
      !date ||
      !bill_no ||
      !customer_name ||
      !driver_name
    ) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    try {

      // =========================
      // GET OLD ITEMS
      // =========================

      const oldItems = await query(
        `
        SELECT *
        FROM sales_items
        WHERE sales_id = ?
        `,
        [saleId]
      );

      // =========================
      // RETURN OLD STOCK
      // =========================

      for (const old of oldItems) {

        await query(
          `
          UPDATE product
          SET quantity = quantity + ?
          WHERE product_code = ?
          `,
          [
            old.quantity,
            old.product_code,
          ]
        );

      }

      // =========================
      // VALIDATE NEW STOCK
      // =========================

      const aggregatedQuantities = {};

      for (const item of itemsToProcess) {

        const q =
          parseInt(item.quantity, 10) || 0;

        aggregatedQuantities[
          item.product_code
        ] =
          (
            aggregatedQuantities[
              item.product_code
            ] || 0
          ) + q;

      }

      for (const code in aggregatedQuantities) {

        const totalNeeded =
          aggregatedQuantities[code];

        const stockResult = await query(
          `
          SELECT quantity
          FROM product
          WHERE product_code = ?
          `,
          [code]
        );

        if (
          stockResult[0].quantity <
          totalNeeded
        ) {

          // RESTORE OLD STOCK BACK

          for (const old of oldItems) {

            await query(
              `
              UPDATE product
              SET quantity = quantity - ?
              WHERE product_code = ?
              `,
              [
                old.quantity,
                old.product_code,
              ]
            );

          }

          return res.status(400).json({
            success: false,
            message:
              `Insufficient stock for ${code}`,
          });

        }

      }

      // =========================
      // DELETE OLD ITEMS
      // =========================

      await query(
        `
        DELETE FROM sales_items
        WHERE sales_id = ?
        `,
        [saleId]
      );

      // =========================
      // RESET STATUS
      // =========================

      await query(
        `
        UPDATE sales
        SET status = 'pending'
        WHERE id = ?
        `,
        [saleId]
      );

      // =========================
      // UPDATE SALES
      // =========================

      const basicProductCode =
        itemsToProcess[0]?.product_code || "";

      const basicQuantity =
        itemsToProcess[0]?.quantity || 0;

      await query(
        `
        UPDATE sales
        SET
          date=?,
          bill_no=?,
          customer_name=?,
          vehicle_no=?,
          driver_name=?,
          driver_number=?,
          transporter_name=?,
          lr_number=?,
          product_code=?,
          quantity=?
        WHERE id=?
        `,
        [
          date,
          bill_no,
          customer_name,
          vehicle_no || "",
          driver_name,
          driver_number || "",
          transporter_name || "",
          lr_number || "",
          basicProductCode,
          basicQuantity,
          saleId,
        ]
      );

      // =========================
      // INSERT NEW ITEMS
      // =========================

      for (const item of itemsToProcess) {

        const parsedQuantity = parseInt(
          item.quantity,
          10
        );

        // INSERT ITEM

        await query(
          `
          INSERT INTO sales_items
          (
            sales_id,
            product_code,
            product_name,
            gradation,
            quantity
          )
          VALUES (?, ?, ?, ?, ?)
          `,
          [
            saleId,
            item.product_code,
            item.product_name,
            item.gradation,
            parsedQuantity,
          ]
        );

        // REMOVE STOCK

        await query(
          `
          UPDATE product
          SET quantity = quantity - ?
          WHERE product_code = ?
          `,
          [
            parsedQuantity,
            item.product_code,
          ]
        );

      }

      // =========================
      // AUTO STATUS
      // =========================

      if (itemsToProcess.length > 0) {

        await query(
          `
          UPDATE sales
          SET status = 'stock_out'
          WHERE id = ?
          `,
          [saleId]
        );

      }

      res.json({
        success: true,
        message: "Sale updated successfully",
      });

    } catch (err) {

      console.error(
        "Sale Update Error:",
        err
      );

      res.status(500).json({
        success: false,
        message: "Update Error",
        error: err.message,
      });

    }

  }
);

// ======================================================
// DELETE SALE
// ======================================================

router.delete(
  "/delete/:id",
  authenticateAndAuthorize(),
  async (req, res) => {

    const saleId = req.params.id;

    try {

      // GET ITEMS

      const oldItems = await query(
        `
        SELECT *
        FROM sales_items
        WHERE sales_id = ?
        `,
        [saleId]
      );

      // RETURN STOCK

      for (const old of oldItems) {

        await query(
          `
          UPDATE product
          SET quantity = quantity + ?
          WHERE product_code = ?
          `,
          [
            old.quantity,
            old.product_code,
          ]
        );

      }

      // DELETE ITEMS

      await query(
        `
        DELETE FROM sales_items
        WHERE sales_id = ?
        `,
        [saleId]
      );

      // DELETE SALE

      await query(
        `
        DELETE FROM sales
        WHERE id = ?
        `,
        [saleId]
      );

      res.json({
        success: true,
        message: "Sale deleted successfully",
      });

    } catch (err) {

      console.error(
        "Sale Delete Error:",
        err
      );

      res.status(500).json({
        success: false,
        message: "Delete Error",
        error: err.message,
      });

    }

  }
);

// ======================================================
// DELETE SALE ITEM
// ======================================================

router.delete(
  "/delete-item/:itemId",
  authenticateAndAuthorize(),
  async (req, res) => {

    const itemId = req.params.itemId;

    try {

      // GET ITEM

      const itemResult = await query(
        `
        SELECT *
        FROM sales_items
        WHERE id = ?
        `,
        [itemId]
      );

      if (itemResult.length === 0) {
        return res.status(404).json({
          success: false,
          message: "Item not found",
        });
      }

      const item = itemResult[0];

      // RETURN STOCK

      await query(
        `
        UPDATE product
        SET quantity = quantity + ?
        WHERE product_code = ?
        `,
        [
          item.quantity,
          item.product_code,
        ]
      );

      // DELETE ITEM

      await query(
        `
        DELETE FROM sales_items
        WHERE id = ?
        `,
        [itemId]
      );

      // CHECK REMAINING ITEMS

      const remainingItems = await query(
        `
        SELECT *
        FROM sales_items
        WHERE sales_id = ?
        `,
        [item.sales_id]
      );

      // AUTO STATUS

      if (remainingItems.length === 0) {

        await query(
          `
          UPDATE sales
          SET status = 'pending'
          WHERE id = ?
          `,
          [item.sales_id]
        );

      }

      res.json({
        success: true,
        message: "Item deleted successfully",
      });

    } catch (err) {

      console.error(
        "Delete Item Error:",
        err
      );

      res.status(500).json({
        success: false,
        message: "Delete Item Error",
        error: err.message,
      });

    }

  }
);

// ======================================================
// GET SALES
// ======================================================

router.get(
  "/read",
  authenticateAndAuthorize(),
  (req, res) => {

    const getQuery = `
      SELECT s.*,
      (
        SELECT COUNT(*)
        FROM sales_items si
        WHERE si.sales_id = s.id
      ) as items_count
      FROM sales s
      ORDER BY s.id DESC
    `;

    db.query(
      getQuery,
      (err, salesResults) => {

        if (err) {
          return res.status(500).json({
            success: false,
            message: "DB Error",
            error: err.message,
          });
        }

        const itemsQuery =
          "SELECT * FROM sales_items";

        db.query(
          itemsQuery,
          (err2, itemResults) => {

            if (err2) {
              return res.status(500).json({
                success: false,
                message: "DB Items Error",
                error: err2.message,
              });
            }

            const salesWithItems =
              salesResults.map((s) => ({
                ...s,
                items: itemResults.filter(
                  (i) =>
                    i.sales_id === s.id
                ),
              }));

            res.json({
              success: true,
              data: salesWithItems,
            });

          }
        );

      }
    );

  }
);

// ======================================================
// UPDATE STATUS
// ======================================================

router.put(
  "/update-status/:id",
  authenticateAndAuthorize(),
  async (req, res) => {

    const salesId = req.params.id;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: "Status is required",
      });
    }

    try {

      await query(
        `
        UPDATE sales
        SET status = ?
        WHERE id = ?
        `,
        [status, salesId]
      );

      res.json({
        success: true,
        message: "Status updated successfully",
      });

    } catch (err) {

      console.error(
        "Status Update Error:",
        err
      );

      res.status(500).json({
        success: false,
        message: "Status Update Error",
        error: err.message,
      });

    }

  }
);

module.exports = router;