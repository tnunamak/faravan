import {test,expect} from "@playwright/test";
import {startHarness} from "./lib.mjs";
let harness;
test.beforeAll(async()=>{harness=await startHarness();});
test.afterAll(async()=>{await harness?.stop();});

test("a second circle submits once, retains the first, and renames only its own profile",async({page})=>{
 const first={id:"first",name:"Weekend projects",origin:"http://fixture",owned:true};
 let circles=[first],creates=0,saves=0,release;
 const pending=new Promise(resolve=>{release=resolve;});
 await page.route("**/api/circles",async r=>{
  if(r.request().method()==="POST"){
   creates++;expect(r.request().postDataJSON()).toEqual({name:"Neighbours"});await pending;
   const second={id:"second",name:"Neighbours",purpose:"",origin:first.origin,owned:true};circles=[first,second];return r.fulfill({json:second});
  }
  return r.fulfill({json:circles});
 });
 await page.route("**/api/hosting",r=>r.fulfill({json:{configured:true,running:true}}));
 await page.route("**/api/circles/second",r=>r.fulfill({json:circles[1]}));
 for(const endpoint of ["people","approvals","invitations"])await page.route("**/api/circles/second/"+endpoint,r=>r.fulfill({json:[]}));
 await page.route("**/api/circles/second/profile",r=>{
  saves++;expect(r.request().postDataJSON()).toEqual({name:"Book club",purpose:"Reading together"});
  circles=[first,{...circles[1],name:"Book club",purpose:"Reading together"}];return r.fulfill({json:circles[1]});
 });
 await page.goto((await harness.link('owner'))+"#/circles");
 await expect(page.getByRole("link",{name:/Weekend projects/}).last()).toBeVisible();
 await page.getByRole("link",{name:"Start a circle",exact:true}).click();
 await page.getByLabel("Circle name",{exact:true}).fill(" Neighbours ");
 await page.getByRole("button",{name:"Start circle",exact:true}).click();
 await expect(page.getByRole("button",{name:"Start circle",exact:true})).toBeDisabled();
 await page.locator("form.host").evaluate(el=>el.requestSubmit());
 expect(creates).toBe(1);release();
 await expect(page).toHaveURL(/#\/circle\/second$/);
 await page.getByRole("tab",{name:"Settings",exact:true}).click();
 await page.getByLabel("Circle name",{exact:true}).fill(" Book club ");
 await page.getByLabel("Purpose",{exact:true}).fill(" Reading together ");
 await page.getByRole("button",{name:"Save circle",exact:true}).click();
 await expect(page.getByText("Circle details saved.",{exact:true})).toBeVisible();
 await expect(page.getByLabel("Circle name",{exact:true})).toHaveValue(" Book club ");
 await expect(page.getByRole("button",{name:"Save circle",exact:true})).toBeDisabled();
 expect(saves).toBe(1);expect(circles[0]).toEqual(first);
 await page.goto((await harness.link('owner'))+"#/circles");
 await expect(page.locator("main").getByRole("link",{name:/Weekend projects/})).toHaveCount(1);
 await expect(page.locator("main").getByRole("link",{name:/Book club/})).toHaveCount(1);
});
