// Standalone bundle exposing the menu component and vendor icons to plain-JS
// webviews (grid.js).
import { closeMenus, showMenu } from './menu';
import { vendorIconSvg } from './vendorIcons';

(globalThis as any).tableclothMenu = { showMenu, closeMenus, vendorIconSvg };
