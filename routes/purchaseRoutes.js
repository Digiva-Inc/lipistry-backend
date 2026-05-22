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
// CREATE PURCHASE
// ======================================================

router.post(
  "/create",
  authenticateAndAuthorize(),
  async (req, res) => {

    const {
      date,
      bill_no,
      party_name,
      vehicle_no,
      driver_name,
      driver_number,
      transporter_name,
      lr_number,
      items,
    } = req.body;

    if (!date || !bill_no || !driver_name) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    try {

      const basicProductCode =
        items && items.length > 0
          ? items[0].product_code
          : "";

      const basicQuantity =
        items && items.length > 0
          ? items[0].quantity
          : 0;

      const created_by = req.user.name;

      // AUTO STATUS

      const autoStatus =
        items && items.length > 0
          ? "stock_in"
          : "pending";

      // CREATE PURCHASE

      const purchaseResult = await query(
        `
        INSERT INTO purchase
        (
          date,
          bill_no,
          party_name,
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
          party_name || null,
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

      const purchaseId = purchaseResult.insertId;

      // INSERT ITEMS + ADD STOCK

      if (items && items.length > 0) {

        for (const item of items) {

          const parsedQuantity = parseInt(
            item.quantity,
            10
          );

          // INSERT ITEM

          await query(
            `
            INSERT INTO purchase_items
            (
              purchase_id,
              product_code,
              product_name,
              gradation,
              quantity
            )
            VALUES (?, ?, ?, ?, ?)
            `,
            [
              purchaseId,
              item.product_code,
              item.product_name,
              item.gradation,
              parsedQuantity,
            ]
          );

          // ADD STOCK

          await query(
            `
            UPDATE product
            SET quantity = quantity + ?
            WHERE product_code = ?
            `,
            [
              parsedQuantity,
              item.product_code,
            ]
          );

        }

      }

      res.json({
        success: true,
        message: "Purchase created successfully",
        insertedId: purchaseId,
      });

    } catch (err) {

      console.error(
        "Purchase Insert Error:",
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
// ADD ITEM
// ======================================================

router.post(
  "/add-item/:id",
  authenticateAndAuthorize(),
  async (req, res) => {

    const purchaseId = req.params.id;

    const {
      product_code,
      product_name,
      gradation,
      quantity,
    } = req.body;

    if (!product_code || !quantity) {
      return res.status(400).json({
        success: false,
        message:
          "Product and Quantity are required",
      });
    }

    try {

      const parsedQuantity = parseInt(
        quantity,
        10
      );

      // INSERT ITEM

      await query(
        `
        INSERT INTO purchase_items
        (
          purchase_id,
          product_code,
          product_name,
          gradation,
          quantity
        )
        VALUES (?, ?, ?, ?, ?)
        `,
        [
          purchaseId,
          product_code,
          product_name,
          gradation,
          parsedQuantity,
        ]
      );

      // ADD STOCK

      await query(
        `
        UPDATE product
        SET quantity = quantity + ?
        WHERE product_code = ?
        `,
        [
          parsedQuantity,
          product_code,
        ]
      );

      // AUTO STATUS CHANGE

      await query(
        `
        UPDATE purchase
        SET status = 'stock_in'
        WHERE id = ?
        `,
        [purchaseId]
      );

      res.json({
        success: true,
        message: "Item added successfully",
      });

    } catch (err) {

      console.error(
        "Item Insert Error:",
        err
      );

      res.status(500).json({
        success: false,
        message: "Item Insert Error",
        error: err.message,
      });

    }

  }
);

// ======================================================
// UPDATE PURCHASE
// ======================================================

router.put(
  "/update/:id",
  authenticateAndAuthorize(),
  async (req, res) => {

    const purchaseId = req.params.id;

    const {
      date,
      bill_no,
      party_name,
      vehicle_no,
      driver_name,
      driver_number,
      transporter_name,
      lr_number,
      items,
    } = req.body;

    const itemsToProcess = items || [];

    if (!date || !bill_no || !driver_name) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    try {

      // GET OLD ITEMS

      const oldItems = await query(
        `
        SELECT *
        FROM purchase_items
        WHERE purchase_id = ?
        `,
        [purchaseId]
      );

      // REMOVE OLD STOCK

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

      // DELETE OLD ITEMS

      await query(
        `
        DELETE FROM purchase_items
        WHERE purchase_id = ?
        `,
        [purchaseId]
      );

      // RESET STATUS

      await query(
        `
        UPDATE purchase
        SET status = 'pending'
        WHERE id = ?
        `,
        [purchaseId]
      );

      // UPDATE PURCHASE

      const basicProductCode =
        itemsToProcess[0]?.product_code || "";

      const basicQuantity =
        itemsToProcess[0]?.quantity || 0;

      await query(
        `
        UPDATE purchase
        SET
          date=?,
          bill_no=?,
          party_name=?,
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
          party_name || null,
          vehicle_no || "",
          driver_name,
          driver_number || "",
          transporter_name || "",
          lr_number || "",
          basicProductCode,
          basicQuantity,
          purchaseId,
        ]
      );

      // INSERT NEW ITEMS + ADD STOCK

      for (const item of itemsToProcess) {

        const parsedQuantity = parseInt(
          item.quantity,
          10
        );

        // INSERT ITEM

        await query(
          `
          INSERT INTO purchase_items
          (
            purchase_id,
            product_code,
            product_name,
            gradation,
            quantity
          )
          VALUES (?, ?, ?, ?, ?)
          `,
          [
            purchaseId,
            item.product_code,
            item.product_name,
            item.gradation,
            parsedQuantity,
          ]
        );

        // ADD STOCK

        await query(
          `
          UPDATE product
          SET quantity = quantity + ?
          WHERE product_code = ?
          `,
          [
            parsedQuantity,
            item.product_code,
          ]
        );

      }

      // AUTO STATUS CHANGE

      if (itemsToProcess.length > 0) {

        await query(
          `
          UPDATE purchase
          SET status = 'stock_in'
          WHERE id = ?
          `,
          [purchaseId]
        );

      }

      res.json({
        success: true,
        message: "Purchase updated successfully",
      });

    } catch (err) {

      console.error(
        "Purchase Update Error:",
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
// DELETE PURCHASE
// ======================================================

router.delete(
  "/delete/:id",
  authenticateAndAuthorize(),
  async (req, res) => {

    const purchaseId = req.params.id;

    try {

      // GET ITEMS

      const oldItems = await query(
        `
        SELECT *
        FROM purchase_items
        WHERE purchase_id = ?
        `,
        [purchaseId]
      );

      // REMOVE STOCK

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

      // DELETE ITEMS

      await query(
        `
        DELETE FROM purchase_items
        WHERE purchase_id = ?
        `,
        [purchaseId]
      );

      // DELETE PURCHASE

      await query(
        `
        DELETE FROM purchase
        WHERE id = ?
        `,
        [purchaseId]
      );

      res.json({
        success: true,
        message: "Purchase deleted successfully",
      });

    } catch (err) {

      console.error(
        "Purchase Delete Error:",
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
// DELETE ITEM
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
        FROM purchase_items
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

      // REMOVE STOCK

      await query(
        `
        UPDATE product
        SET quantity = quantity - ?
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
        DELETE FROM purchase_items
        WHERE id = ?
        `,
        [itemId]
      );

      // CHECK REMAINING ITEMS

      const remainingItems = await query(
        `
        SELECT *
        FROM purchase_items
        WHERE purchase_id = ?
        `,
        [item.purchase_id]
      );

      // AUTO STATUS PENDING

      if (remainingItems.length === 0) {

        await query(
          `
          UPDATE purchase
          SET status = 'pending'
          WHERE id = ?
          `,
          [item.purchase_id]
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
// GET PURCHASES
// ======================================================

router.get(
  "/read",
  authenticateAndAuthorize(),
  (req, res) => {

    const getQuery = `
      SELECT p.*,
      (
        SELECT COUNT(*)
        FROM purchase_items pi
        WHERE pi.purchase_id = p.id
      ) as items_count
      FROM purchase p
      ORDER BY p.id DESC
    `;

    db.query(
      getQuery,
      (err, purchaseResults) => {

        if (err) {
          return res.status(500).json({
            success: false,
            message: "DB Error",
            error: err.message,
          });
        }

        const itemsQuery =
          "SELECT * FROM purchase_items";

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

            const purchasesWithItems =
              purchaseResults.map((p) => ({
                ...p,
                items: itemResults.filter(
                  (i) =>
                    i.purchase_id === p.id
                ),
              }));

            res.json({
              success: true,
              data: purchasesWithItems,
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

    const purchaseId = req.params.id;
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
        UPDATE purchase
        SET status = ?
        WHERE id = ?
        `,
        [status, purchaseId]
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