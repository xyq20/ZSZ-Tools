function restoreWindow(win){if(!win||win.isDestroyed())return;if(win.isMinimized())win.restore();win.show();win.focus();}
function bindLoginWindow(login,main){
 login.on('minimize',()=>restoreWindow(main));
 login.on('closed',()=>restoreWindow(main));
}
module.exports={restoreWindow,bindLoginWindow};
