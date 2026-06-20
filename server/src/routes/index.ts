import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import filesRouter from "./files/index.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(filesRouter);

export default router;
